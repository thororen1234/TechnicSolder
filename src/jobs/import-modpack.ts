import { db } from '../database/prisma.js'
import { appUrl, route } from '../http/urls.js'
import { recordActivity } from '../models/activity-log.js'
import {
    addLogEntry,
    archiveExists,
    COMPLETED,
    deleteArchive,
    FAILED,
    importProblems,
    isFinished,
    RUNNING,
    updateImport,
    WAITING,
} from '../models/modpack-import.js'
import { grantModpackAccess } from '../models/permissions.js'
import { permissionFor } from '../models/relations.js'
import type { ModpackImport } from '../models/types.js'
import { downloadFile } from '../mods/mod-provider.js'
import { DiscordNotifier } from '../services/discord-notifier.js'
import { PackImportService } from '../services/pack-import.js'
import { TaskTracker, taskProgress } from '../services/task-tracker.js'
import { Cache } from '../support/cache.js'
import { deleteLocal, localPath, makeLocalDirectory } from '../support/storage.js'
import { extension, limit, plural, uuid } from '../support/str.js'
import { registerJob } from './queue.js'

/**
 * Run a modpack import in the background, reporting progress to a task and keeping a log on the import.
 * An import into a modpack that already has the build version stops and keeps its archive until someone decides.
 */
interface Payload {
    taskId: string
    importId: number
}

/** Download an import from a URL into the local disk, so it can be kept if the import has to wait */
async function download(taskId: string, modpackImport: ModpackImport): Promise<string | null> {
    let path = ''
    try {
        path = new URL(modpackImport.source).pathname
    } catch {
        // Not a URL; the download will report it
    }
    const fileExtension = extension(path)
    const relativePath = `imports/${uuid()}${/^[A-Za-z0-9]{1,8}$/.test(fileExtension) ? `.${fileExtension}` : ''}`
    await TaskTracker.progress(taskId, 0, 0, 'Downloading the archive')
    await addLogEntry(modpackImport, 'info', `Downloading ${modpackImport.source}`)
    makeLocalDirectory('imports')
    const error = await downloadFile(modpackImport.source, localPath(relativePath))
    if (error !== null) {
        deleteLocal(relativePath)
        return error
    }
    await updateImport(modpackImport, { archive_path: relativePath })
    return null
}

async function markFailed(taskId: string, modpackImport: ModpackImport, error: string): Promise<void> {
    await deleteArchive(modpackImport)
    await updateImport(modpackImport, { status: FAILED, problems: [...importProblems(modpackImport), error] })
    await addLogEntry(modpackImport, 'error', error)
    await TaskTracker.fail(taskId, error)
    await DiscordNotifier.send(`Import of ${modpackImport.name} failed`, error, route('modpack.import.show', modpackImport.id), DiscordNotifier.DANGER)
}

async function waitForDecision(taskId: string, modpackImport: ModpackImport, modpackName: string, version: string): Promise<void> {
    const message = `${modpackName} already has a build ${version}.`
    await updateImport(modpackImport, { status: WAITING, build_version: version, problems: [message] })
    await addLogEntry(modpackImport, 'info', `${message} Waiting for a decision: overwrite it, import under another version or cancel.`)
    await TaskTracker.complete(taskId, {
        url: route('modpack.import.show', modpackImport.id),
        label: 'Choose what to do',
        message,
        redirect: true,
    })
}

async function complete(
    taskId: string,
    modpackImport: ModpackImport,
    result: { modpack_id: number; build_id: number; imported: number; skipped: number; errors: string[] },
): Promise<void> {
    const intoExisting = modpackImport.slug === null
    const modpack = await db.modpack.findUnique({ where: { id: result.modpack_id } })
    const build = await db.build.findUnique({ where: { id: result.build_id } })
    let message = `${result.imported} mod(s) imported.`
    if (result.skipped > 0) {
        message += ` ${result.skipped} skipped.`
    }
    await updateImport(modpackImport, {
        status: COMPLETED,
        modpack_id: result.modpack_id,
        build_id: result.build_id,
        imported: result.imported,
        skipped: result.skipped,
        problems: result.errors,
    })
    await addLogEntry(modpackImport, 'info', `Finished. ${message}`)
    const properties = { imported: result.imported, skipped: result.skipped, import_id: modpackImport.id }
    if (intoExisting) {
        await recordActivity('build.imported', `${modpackImport.overwrite ? 'Overwrote' : 'Imported'} build ${build?.version ?? ''} from ${modpackImport.source}`, {
            build,
            userId: modpackImport.user_id,
            properties,
        })
    } else {
        const permission = modpackImport.user_id === null ? null : await permissionFor(modpackImport.user_id)
        if (permission) {
            await grantModpackAccess(permission, result.modpack_id)
        }
        await recordActivity('modpack.imported', `Imported modpack ${modpackImport.name}`, { modpack, userId: modpackImport.user_id, properties })
        await Cache.forget('modpacks', 'allmodpacks')
    }
    const url = intoExisting ? appUrl(`modpack/build/${result.build_id}`) : appUrl(`modpack/view/${result.modpack_id}`)
    const problems = result.errors.length
    await DiscordNotifier.send(
        intoExisting ? `Imported ${modpack?.name ?? ''} ${build?.version ?? ''}` : `Imported modpack ${modpackImport.name}`,
        message + (problems ? `\n${problems} ${plural('problem', problems)} need attention.` : ''),
        problems ? route('modpack.import.show', modpackImport.id) : url,
        problems ? DiscordNotifier.WARNING : DiscordNotifier.SUCCESS,
    )
    await TaskTracker.complete(
        taskId,
        {
            url,
            label: intoExisting ? 'Open build' : 'Open modpack',
            message,
            report_url: route('modpack.import.show', modpackImport.id),
        },
        result.errors,
    )
}

export const ImportModpack = registerJob<Payload>({
    name: 'ImportModpack',
    async handle({ taskId, importId }) {
        const modpackImport = await db.modpackImport.findUniqueOrThrow({ where: { id: importId } })
        await updateImport(modpackImport, { status: RUNNING })
        if (modpackImport.archive_path === null) {
            const error = await download(taskId, modpackImport)
            if (error !== null) {
                await markFailed(taskId, modpackImport, `Could not download the archive: ${error}`)
                return
            }
        }
        if (!archiveExists(modpackImport)) {
            await markFailed(taskId, modpackImport, 'The archive is no longer available. Start the import again.')
            return
        }
        const modpack = modpackImport.modpack_id === null ? null : await db.modpack.findUnique({ where: { id: modpackImport.modpack_id } })
        if (modpackImport.slug === null && modpack === null) {
            await markFailed(taskId, modpackImport, 'The modpack this was being imported into has been deleted.')
            return
        }
        const importer = new PackImportService(taskProgress(taskId), (level, message) => addLogEntry(modpackImport, level, message))
        const path = localPath(String(modpackImport.archive_path))
        const result =
            modpackImport.slug !== null
                ? await importer.importFromPath(path, modpackImport.name, modpackImport.slug)
                : await importer.importIntoModpack(path, modpack!, modpackImport.build_version, modpackImport.overwrite)
        if ('conflict' in result) {
            await waitForDecision(taskId, modpackImport, modpack?.name ?? '', result.conflict)
            return
        }
        await deleteArchive(modpackImport)
        if ('error' in result) {
            await markFailed(taskId, modpackImport, result.error)
            return
        }
        await complete(taskId, modpackImport, result)
    },
    async failed({ taskId, importId }, error) {
        const message = `The import stopped unexpectedly: ${limit(error.message, 300)}`
        await TaskTracker.fail(taskId, message)
        const modpackImport = await db.modpackImport.findUnique({ where: { id: importId } })
        if (modpackImport !== null && !isFinished(modpackImport)) {
            await deleteArchive(modpackImport)
            await updateImport(modpackImport, { status: FAILED, problems: [...importProblems(modpackImport), message] })
            await addLogEntry(modpackImport, 'error', message)
        }
    },
})
