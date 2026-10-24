import { copyFileSync, renameSync } from 'node:fs'
import { db } from '../database/prisma.js'
import { appUrl } from '../http/urls.js'
import { recordActivity } from '../models/activity-log.js'
import { BuildUpdateService } from '../services/build-update.js'
import { PackExportService } from '../services/pack-export.js'
import { TaskTracker, taskProgress } from '../services/task-tracker.js'
import { removeFile } from '../support/files.js'
import { deleteLocal, lastModified, localFiles, localPath, makeLocalDirectory } from '../support/storage.js'
import { limit, plural } from '../support/str.js'
import { registerJob } from './queue.js'

/** Create a new build with the chosen mod updates applied, in the background */
export const UpdateBuild = registerJob<{ taskId: string; buildId: number; newVersion: string; modversionIds: number[]; userId: number | null }>({
    name: 'UpdateBuild',
    async handle({ taskId, buildId, newVersion, modversionIds, userId }) {
        const build = await db.build.findUnique({ where: { id: buildId } })
        if (build === null) {
            await TaskTracker.fail(taskId, 'The build no longer exists.')
            return
        }
        const result = await new BuildUpdateService(taskProgress(taskId)).apply(build, newVersion, modversionIds)
        await recordActivity(
            'build.created',
            `Created build ${result.build.version} from ${build.version} with ${result.updated} ${plural('update', result.updated)}`,
            { build: result.build, userId },
        )
        await TaskTracker.complete(
            taskId,
            {
                url: appUrl(`modpack/build/${result.build.id}`),
                label: `Open build ${result.build.version}`,
                message: `Build ${result.build.version} created with ${result.updated} ${plural('update', result.updated)}.`,
            },
            result.errors,
        )
    },
    async failed({ taskId }, error) {
        await TaskTracker.fail(taskId, `The update stopped unexpectedly: ${limit(error.message, 300)}`)
    },
})

/** Copy a build to another Minecraft version in the background */
export const CopyBuildToMinecraft = registerJob<{ taskId: string; buildId: number; newVersion: string; minecraft: string; userId: number | null }>({
    name: 'CopyBuildToMinecraft',
    async handle({ taskId, buildId, newVersion, minecraft, userId }) {
        const build = await db.build.findUnique({ where: { id: buildId } })
        if (build === null) {
            await TaskTracker.fail(taskId, 'The build no longer exists.')
            return
        }
        const result = await new BuildUpdateService(taskProgress(taskId)).copyToMinecraft(build, newVersion, minecraft)
        await recordActivity('build.created', `Created build ${result.build.version} for Minecraft ${minecraft} from build ${build.version}`, {
            build: result.build,
            userId,
        })
        await TaskTracker.complete(
            taskId,
            {
                url: appUrl(`modpack/build/${result.build.id}`),
                label: `Open build ${result.build.version}`,
                message: `Build ${result.build.version} for Minecraft ${minecraft} created; ${result.updated} ${plural('mod', result.updated)} moved to a compatible version.`,
            },
            result.errors,
        )
    },
    async failed({ taskId }, error) {
        await TaskTracker.fail(taskId, `The copy stopped unexpectedly: ${limit(error.message, 300)}`)
    },
})

/** Exports are kept in storage/app/private/exports for a day */
export const EXPORT_DIRECTORY = 'exports'

/** Delete exports older than a day */
export function pruneOldExports(): void {
    const cutoff = Date.now() - 86_400_000
    for (const file of localFiles(EXPORT_DIRECTORY)) {
        if (lastModified(file) < cutoff) {
            deleteLocal(file)
        }
    }
}

/** Export a build in the background */
export const ExportBuild = registerJob<{ taskId: string; buildId: number; format: string }>({
    name: 'ExportBuild',
    async handle({ taskId, buildId, format }) {
        const build = await db.build.findUnique({ where: { id: buildId } })
        const modpack = build ? await db.modpack.findUnique({ where: { id: build.modpack_id } }) : null
        if (build === null || modpack === null) {
            await TaskTracker.fail(taskId, 'The build no longer exists.')
            return
        }
        pruneOldExports()
        const exported = await new PackExportService(taskProgress(taskId)).exportBuild(build, modpack, format)
        makeLocalDirectory(EXPORT_DIRECTORY)
        const relative = `${EXPORT_DIRECTORY}/${taskId}`
        try {
            renameSync(exported.path, localPath(relative))
        } catch {
            // The temporary directory may be on another filesystem
            copyFileSync(exported.path, localPath(relative))
            removeFile(exported.path)
        }
        await TaskTracker.complete(
            taskId,
            { path: relative, filename: exported.filename, label: `Download ${exported.filename}`, message: 'Your export is ready.' },
            exported.warnings,
        )
    },
    async failed({ taskId }, error) {
        await TaskTracker.fail(taskId, `The export stopped unexpectedly: ${limit(error.message, 300)}`)
    },
})
