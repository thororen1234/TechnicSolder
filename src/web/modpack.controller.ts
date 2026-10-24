import { Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common'
import type { Request, Response } from 'express'
import { db, type TransactionClient } from '../database/prisma.js'
import { abort } from '../http/errors.js'
import { AuthGuard } from '../http/guards.js'
import { appUrl, route } from '../http/urls.js'
import { Redirect, Web } from '../http/web.js'
import { CopyBuildToMinecraft, ExportBuild, UpdateBuild } from '../jobs/build-jobs.js'
import { ImportModpack } from '../jobs/import-modpack.js'
import { runTask } from '../jobs/queue.js'
import { recordActivity } from '../models/activity-log.js'
import { buildLoader, isLive, BUILD_COPY_FIELDS } from '../models/build.js'
import { buildDownloadsDaily, buildDownloadTotals } from '../models/build-download.js'
import { JAVA_RUNTIMES, JAVA_VERSIONS } from '../models/java.js'
import { hasPrivateBuilds } from '../models/modpack.js'
import { addLogEntry, archiveExists, CANCELLED, deleteArchive, importLog, importProblems, QUEUED, updateImport, WAITING } from '../models/modpack-import.js'
import { canAccessModpack, grantModpackAccess } from '../models/permissions.js'
import {
    buildsByIds,
    buildsForModpack,
    buildsForModpacks,
    clientsForModpack,
    indexBy,
    modversionCounts,
    modversionIdsForBuild,
    modversionsForBuild,
    syncBuildModversions,
    syncClientModpacks,
    usersByIds,
    versionsForMods,
    withMods,
} from '../models/relations.js'
import type { Build, Modpack, ModpackImport, ModversionWithMod } from '../models/types.js'
import { allows, authorize, Policies } from '../policies/gate.js'
import { checkBuildHealth } from '../services/build-health.js'
import { BuildUpdateService } from '../services/build-update.js'
import { DiscordNotifier } from '../services/discord-notifier.js'
import { getMinecraftVersions } from '../services/minecraft.js'
import { FORMATS, isExportFormat, PackExportService } from '../services/pack-export.js'
import { TaskTracker } from '../services/task-tracker.js'
import { Cache } from '../support/cache.js'
import { localPath, makeLocalDirectory } from '../support/storage.js'
import { plural, slug as toSlug, ucfirst, uuid } from '../support/str.js'
import { Rule, validate } from '../support/validation.js'
import { withActivityRelations } from './solder.controller.js'

function routeId(req: Request, name: string): number | null {
    const value = Number(req.params[name])
    return Number.isInteger(value) ? value : null
}

async function findModpack(req: Request): Promise<Modpack | null> {
    const id = routeId(req, 'modpack_id')
    return id === null ? null : db.modpack.findUnique({ where: { id } })
}

async function findBuild(req: Request): Promise<(Build & { modpack: Modpack }) | null> {
    const id = routeId(req, 'build_id')
    const build = id === null ? null : await db.build.findUnique({ where: { id } })
    const modpack = build ? await db.modpack.findUnique({ where: { id: build.modpack_id } }) : null
    return build && modpack ? { ...build, modpack } : null
}

async function forgetModpack(modpack: Pick<Modpack, 'slug'>, ...more: string[]): Promise<void> {
    await Cache.forget(`modpack:${modpack.slug}`, ...more)
}

/** Send the result of a task that may already have finished (no queue worker), or go to its progress page */
async function followTask(web: Web, taskId: string, onFailure: Redirect | null): Promise<void> {
    const task = await TaskTracker.get(taskId)
    if (task?.status === 'completed') {
        const result = task.result ?? {}
        if (onFailure !== null && result.redirect) {
            web.redirect(String(result.url)).send()
            return
        }
        const redirect = web.redirect(String(result.url)).with('success', result.message)
        if (task.errors.length > 0) {
            redirect.withErrors(task.errors)
        }
        redirect.send()
        return
    }
    if (task?.status === 'failed' && onFailure !== null) {
        onFailure.withErrors(task.errors).send()
        return
    }
    web.redirect(route('task.show', taskId)).send()
}

const BUILD_ATTRIBUTES = { version: 'modpack version', 'java-version': 'Java version', 'java-runtime': 'Mojang Java runtime' }
const BUILD_MESSAGES = { 'memory.numeric': 'You may enter in numbers only for the memory requirement' }
const MODPACK_MESSAGES = { name_required: 'You must enter a modpack name.', slug_required: 'You must enter a modpack slug' }

@Controller('modpack')
@UseGuards(AuthGuard)
export class ModpackController {
    @Get()
    index(@Req() req: Request, @Res() res: Response): void {
        Web.of(req, res).redirect('modpack/list').send()
    }

    @Get('list')
    async list(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        authorize(req.user, Policies.modpack.viewAny())
        let modpacks = await db.modpack.findMany({ orderBy: { id: 'asc' } })
        const permission = web.user.permission
        if (!permission?.solder_full) {
            modpacks = modpacks.filter((modpack) => canAccessModpack(permission, modpack.id))
        }
        await web.view('modpack.list', { modpacks })
    }

    @Get('view/:modpack_id')
    async view(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const modpack = await findModpack(req)
        if (!modpack) {
            web.redirect('modpack/list').withErrors(['Modpack not found']).send()
            return
        }
        authorize(req.user, Policies.modpack.update(modpack))
        const builds = await buildsForModpack(modpack.id)
        const counts = await modversionCounts(builds.map((build) => build.id))
        const imports = await db.modpackImport.findMany({ where: { modpack_id: modpack.id }, orderBy: { id: 'desc' }, take: 10 })
        const importBuilds = await buildsByIds(imports.map((modpackImport) => modpackImport.build_id))
        await web.view('modpack.view', {
            modpack: { ...modpack, builds: builds.map((build) => ({ ...build, modversions_count: counts.get(build.id) ?? 0 })) },
            launches: await buildDownloadTotals(builds.map((build) => build.id)),
            activity: await withActivityRelations(await db.activityLog.findMany({ where: { modpack_id: modpack.id }, orderBy: { id: 'desc' }, take: 15 })),
            imports: imports.map((modpackImport) => ({
                ...modpackImport,
                problems: importProblems(modpackImport),
                build: modpackImport.build_id === null ? null : (importBuilds.get(modpackImport.build_id) ?? null),
            })),
        })
    }

    @Get('build/:build_id')
    async build(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const build = await findBuild(req)
        if (!build) {
            web.redirect('modpack/list').withErrors(['Modpack not found']).send()
            return
        }
        authorize(req.user, Policies.build.update(build.modpack))
        const modversions = await modversionsForBuild(build.id)
        const versions = await versionsForMods([...new Set(modversions.map((modversion) => modversion.mod_id))])
        await web.view('modpack.build.view', {
            build: {
                ...build,
                loader: buildLoader(build, modversions),
                isLive: isLive(build),
                modversions: modversions.map((modversion) => ({ ...modversion, mod: { ...modversion.mod, versions: versions.get(modversion.mod_id) ?? [] } })),
            },
            mods: await db.mod.findMany({ orderBy: { id: 'asc' } }),
            launches: await buildDownloadsDaily(build.id),
            activity: await withActivityRelations(await db.activityLog.findMany({ where: { build_id: build.id }, orderBy: { id: 'desc' }, take: 50 })),
        })
    }

    @Get('build/:build_id/export')
    async exportBuildCsv(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const build = await findBuild(req)
        if (!build) {
            web.redirect('modpack/list').withErrors(['Build not found']).send()
            return
        }
        authorize(req.user, Policies.build.update(build.modpack))
        const label = (modversion: ModversionWithMod) => modversion.mod.pretty_name || modversion.mod.name
        const rows = (await modversionsForBuild(build.id)).sort((a, b) => label(a).toLowerCase().localeCompare(label(b).toLowerCase()))
        const csv = [['mod_name', 'mod_slug', 'version', 'md5', 'filesize'], ...rows.map((modversion) => [label(modversion), modversion.mod.name, modversion.version, modversion.md5, modversion.filesize ?? ''])]
            .map((row) => row.map(csvField).join(','))
            .join('\n')
        web.streamDownload(`${csv}\n`, `${build.modpack.slug}_${build.version}.csv`, 'text/csv')
    }

    @Get('build/:build_id/export/:format')
    async exportBuildArchive(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const format = req.params.format as string
        if (!isExportFormat(format)) {
            abort(404)
        }
        const build = await findBuild(req)
        if (!build) {
            web.redirect('modpack/list').withErrors(['Build not found']).send()
            return
        }
        authorize(req.user, Policies.build.update(build.modpack))
        const taskId = await TaskTracker.create(web.userId, `Exporting ${build.modpack.name} ${build.version} (${FORMATS[format].label})`)
        await runTask(ExportBuild, { taskId, buildId: build.id, format })
        // Without a queue worker the export has already finished: send it straight away
        const task = await TaskTracker.get(taskId)
        if (task?.status === 'completed') {
            await web.download(localPath(String(task.result?.path)), String(task.result?.filename))
            return
        }
        web.redirect(route('task.show', taskId)).send()
    }

    @Get('export/:modpack_id')
    async exportModpack(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const modpack = await findModpack(req)
        if (!modpack) {
            web.redirect('modpack/list').withErrors(['Modpack not found']).send()
            return
        }
        authorize(req.user, Policies.modpack.update(modpack))
        const backup = JSON.stringify(await new PackExportService().backup(modpack), null, 4)
        web.streamDownload(backup, `${modpack.slug}-solder-backup.json`, 'application/json')
    }

    /** Compare a build with another build of the same modpack (the previous one by default) */
    @Get('build/:build_id/compare')
    async compare(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const build = await findBuild(req)
        if (!build) {
            web.redirect('modpack/list').withErrors(['Build not found']).send()
            return
        }
        authorize(req.user, Policies.build.update(build.modpack))
        const others = (await buildsForModpack(build.modpack_id)).filter((other) => other.id !== build.id).sort((a, b) => b.id - a.id)
        const withId = web.query('with')
        const base = withId ? (others.find((other) => other.id === Number(withId)) ?? null) : (others.find((other) => other.id < build.id) ?? others[0] ?? null)
        const keyed = (modversions: ModversionWithMod[]) => new Map(modversions.map((modversion) => [modversion.mod.name, modversion]))
        const current = keyed(await modversionsForBuild(build.id))
        const previous = base ? keyed(await modversionsForBuild(base.id)) : new Map<string, ModversionWithMod>()
        const label = (modversion: ModversionWithMod) => modversion.mod.pretty_name || modversion.mod.name
        const byLabel = (a: ModversionWithMod, b: ModversionWithMod) => (label(a) < label(b) ? -1 : label(a) > label(b) ? 1 : 0)
        const added = [...current.entries()].filter(([name]) => !previous.has(name)).map(([, modversion]) => modversion).sort(byLabel)
        const removed = [...previous.entries()].filter(([name]) => !current.has(name)).map(([, modversion]) => modversion).sort(byLabel)
        const updated = [...current.entries()]
            .filter(([name, modversion]) => previous.has(name) && modversion.version !== previous.get(name)!.version)
            .map(([name, modversion]) => ({ from: previous.get(name)!, to: modversion }))
            .sort((a, b) => byLabel(a.to, b.to))
        const sections = [
            `## ${build.modpack.name} ${build.version}`,
            base ? `Changes since ${base.version}:` : null,
            added.length === 0 ? null : `### Added\n${added.map((mv) => `- ${label(mv)} ${mv.version}`).join('\n')}`,
            updated.length === 0 ? null : `### Updated\n${updated.map((change) => `- ${label(change.to)} ${change.from.version} → ${change.to.version}`).join('\n')}`,
            removed.length === 0 ? null : `### Removed\n${removed.map((mv) => `- ${label(mv)}`).join('\n')}`,
        ]
        await web.view('modpack.build.compare', {
            build,
            base,
            others,
            added,
            removed,
            updated,
            unchanged: current.size - added.length - updated.length,
            markdown: sections.filter(Boolean).join('\n\n').trim(),
        })
    }

    @Get('build/:build_id/health')
    async health(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const build = await findBuild(req)
        if (!build) {
            abort(404)
        }
        authorize(req.user, Policies.build.update(build.modpack))
        web.json(await checkBuildHealth(build))
    }

    @Get('build/:build_id/updates')
    async updates(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const build = await findBuild(req)
        if (!build) {
            abort(404)
        }
        authorize(req.user, Policies.build.update(build.modpack))
        web.json({ updates: await new BuildUpdateService().check(build) })
    }

    @Post('build/:build_id/updates')
    async applyUpdates(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const build = await findBuild(req)
        if (!build) {
            web.redirect('modpack/list').withErrors(['Build not found']).send()
            return
        }
        authorize(req.user, Policies.build.update(build.modpack))
        const result = await validate(
            web.all(),
            {
                version: ['required', 'string', 'max:255', Rule.unique('builds', 'version').whereEquals('modpack_id', build.modpack_id)],
                modversions: ['required', 'array', 'min:1'],
                'modversions.*': ['integer'],
            },
            { 'version.unique': 'This modpack already has a build with that version.', 'modversions.required': 'Select at least one update.' },
        )
        if (!result.passes) {
            web.redirect(`modpack/build/${build.id}`).withErrors(result.errors).withInput().send()
            return
        }
        const version = web.string('version')
        const taskId = await TaskTracker.create(web.userId, `Updating ${build.modpack.name} to ${version}`)
        await runTask(UpdateBuild, { taskId, buildId: build.id, newVersion: version, modversionIds: web.array('modversions').map(Number), userId: web.userId })
        await followTask(web, taskId, web.redirect(`modpack/build/${build.id}`))
    }

    @Post('build/:build_id/copy')
    async copyBuild(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const build = await findBuild(req)
        if (!build) {
            web.redirect('modpack/list').withErrors(['Build not found']).send()
            return
        }
        authorize(req.user, Policies.build.update(build.modpack))
        const result = await validate(
            web.all(),
            {
                version: ['required', 'string', 'max:255', Rule.unique('builds', 'version').whereEquals('modpack_id', build.modpack_id)],
                minecraft: ['required', 'string', 'max:64', 'regex:/^\\d+\\.\\d+(\\.\\d+)?$/'],
            },
            { 'version.unique': 'This modpack already has a build with that version.', 'minecraft.regex': 'Enter a Minecraft version such as 1.21.1 or 26.1.' },
        )
        if (!result.passes) {
            web.redirect(`modpack/build/${build.id}`).withErrors(result.errors).withInput().send()
            return
        }
        const version = web.string('version')
        const minecraft = web.string('minecraft')
        const taskId = await TaskTracker.create(web.userId, `Copying ${build.modpack.name} ${build.version} to Minecraft ${minecraft}`)
        await runTask(CopyBuildToMinecraft, { taskId, buildId: build.id, newVersion: version, minecraft, userId: web.userId })
        await followTask(web, taskId, web.redirect(`modpack/build/${build.id}`))
    }

    @Get('build/:build_id/edit')
    async editBuild(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const build = await findBuild(req)
        if (!build) {
            web.redirect('modpack/list').withErrors(['Modpack not found']).send()
            return
        }
        authorize(req.user, Policies.build.update(build.modpack))
        await web.view('modpack.build.edit', { build, minecraft: await getMinecraftVersions() })
    }

    @Post('build/:build_id/edit')
    async updateBuild(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const build = await findBuild(req)
        if (!build) {
            web.redirect('modpack/list').withErrors(['Modpack not found']).send()
            return
        }
        authorize(req.user, Policies.build.update(build.modpack))
        const result = await validate(
            web.all(),
            {
                version: 'required',
                minecraft: 'required',
                memory: ['required_if_accepted:memory-enabled', 'numeric'],
                'java-version': ['nullable', Rule.enum(JAVA_VERSIONS)],
                'java-runtime': ['nullable', 'string', Rule.enum(JAVA_RUNTIMES)],
            },
            BUILD_MESSAGES,
            BUILD_ATTRIBUTES,
        )
        if (!result.passes) {
            web.redirect(`modpack/build/${build.id}/edit`).withErrors(result.errors).withInput().send()
            return
        }
        // Inside a transaction so the modpack's latest/recommended change is rolled back too if anything fails
        const updated = await db.$transaction(async (tx: TransactionClient) => {
            const oldVersion = build.version
            const saved = await tx.build.update({
                where: { id: build.id },
                data: {
                    version: web.string('version'),
                    minecraft: web.string('minecraft'),
                    min_java: web.input<string>('java-version'),
                    ...(web.has('java-runtime') ? { java_runtime: web.input<string>('java-runtime') } : {}),
                    min_memory: web.truthy('memory-enabled') ? Number(web.input('memory')) : 0,
                },
            })
            // When the version changes, the modpack's latest/recommended build follows it
            if (oldVersion !== saved.version) {
                const changes: Partial<Modpack> = {}
                if (build.modpack.latest === oldVersion) {
                    changes.latest = saved.version
                }
                if (build.modpack.recommended === oldVersion) {
                    changes.recommended = saved.version
                }
                if (Object.keys(changes).length > 0) {
                    await tx.modpack.update({ where: { id: build.modpack.id }, data: changes })
                }
            }
            return saved
        })
        await forgetModpack(build.modpack, `modpack:${build.modpack.slug}:build:${updated.version}`, `modpack:${build.modpack.slug}:build:${build.version}`)
        await recordActivity('build.edited', `Edited the details of build ${updated.version}`, { build: updated })
        web.redirect(`modpack/build/${build.id}`).send()
    }

    @Get('build/:build_id/delete')
    async deleteBuild(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const build = await findBuild(req)
        if (!build) {
            web.redirect('modpack/list').withErrors(['Modpack not found']).send()
            return
        }
        authorize(req.user, Policies.build.delete(build.modpack))
        await web.view('modpack.build.delete', { build })
    }

    @Post('build/:build_id/delete')
    async destroyBuild(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const build = await findBuild(req)
        if (!build) {
            web.redirect('modpack/list').withErrors(['Modpack not found']).send()
            return
        }
        authorize(req.user, Policies.build.delete(build.modpack))
        const modpack = build.modpack
        await db.buildModversion.deleteMany({ where: { build_id: build.id } })
        await db.build.delete({ where: { id: build.id } })
        await recordActivity('build.deleted', `Deleted build ${build.version}`, { modpack })
        const changes: Partial<Modpack> = {}
        if (build.version === modpack.recommended || build.version === modpack.latest) {
            const newest = await db.build.findFirst({ where: { modpack_id: modpack.id }, orderBy: { id: 'desc' } })
            if (build.version === modpack.recommended) {
                changes.recommended = newest?.version ?? null
            }
            if (build.version === modpack.latest) {
                changes.latest = newest?.version ?? null
            }
        }
        await db.modpack.update({ where: { id: modpack.id }, data: changes })
        await forgetModpack(modpack, `modpack:${modpack.slug}:build:${build.version}`)
        web.redirect(`modpack/view/${modpack.id}`).with('success', 'Build deleted.').send()
    }

    @Get('add-build/:modpack_id')
    async addBuild(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const modpack = await findModpack(req)
        if (!modpack) {
            web.redirect('modpack/list').withErrors(['Modpack not found']).send()
            return
        }
        authorize(req.user, Policies.build.create(modpack))
        let cloneable = await db.modpack.findMany({ orderBy: { name: 'asc' } })
        const permission = web.user.permission
        if (!permission?.solder_full) {
            cloneable = cloneable.filter((candidate) => canAccessModpack(permission, candidate.id))
        }
        const builds = await buildsForModpacks(cloneable.map((candidate) => candidate.id))
        // The modpack the build is for comes first
        const cloneableModpacks = [...cloneable]
            .sort((a, b) => (a.id === modpack.id ? 0 : 1) - (b.id === modpack.id ? 0 : 1))
            .map((candidate) => ({ ...candidate, builds: [...(builds.get(candidate.id) ?? [])].sort((a, b) => b.id - a.id) }))
        await web.view('modpack.build.create', { modpack, minecraft: await getMinecraftVersions(), cloneableModpacks })
    }

    @Post('add-build/:modpack_id')
    async storeBuild(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const modpack = await findModpack(req)
        if (!modpack) {
            web.redirect('modpack/list').withErrors(['Modpack not found']).send()
            return
        }
        authorize(req.user, Policies.build.create(modpack))
        const result = await validate(
            web.all(),
            {
                version: ['required', Rule.unique('builds', 'version').whereEquals('modpack_id', modpack.id)],
                minecraft: 'required',
                memory: ['required_if_accepted:memory-enabled', 'numeric'],
                'java-version': ['nullable', Rule.enum(JAVA_VERSIONS)],
                'java-runtime': ['nullable', 'string', Rule.enum(JAVA_RUNTIMES)],
            },
            BUILD_MESSAGES,
            BUILD_ATTRIBUTES,
        )
        if (!result.passes) {
            web.redirect(`modpack/add-build/${modpack.id}`).withErrors(result.errors).withInput().send()
            return
        }
        const build = await db.build.create({
            data: {
                modpack_id: modpack.id,
                version: web.string('version'),
                minecraft: web.string('minecraft'),
                min_java: web.input<string>('java-version'),
                java_runtime: web.input<string>('java-runtime'),
                min_memory: web.truthy('memory-enabled') ? Number(web.input('memory')) : 0,
            },
        })
        await recordActivity('build.created', `Created build ${build.version}`, { build })
        await forgetModpack(modpack)
        const clone = web.input('clone')
        if (clone) {
            const cloneId = Number(clone)
            const cloneBuild = Number.isInteger(cloneId) ? await db.build.findUnique({ where: { id: cloneId } }) : null
            if (!cloneBuild) {
                web.redirect(`modpack/build/${build.id}`).withErrors(['Clone source build not found.']).send()
                return
            }
            if (!canAccessModpack(web.user.permission, cloneBuild.modpack_id)) {
                web.redirect(`modpack/build/${build.id}`).withErrors(['You do not have permission to clone from that modpack.']).send()
                return
            }
            await syncBuildModversions(build.id, await modversionIdsForBuild(cloneBuild.id))
        }
        web.redirect(`modpack/build/${build.id}`).send()
    }

    @Get('import')
    async importForm(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        authorize(req.user, Policies.modpack.import())
        const user = web.user
        const modpacks = (await db.modpack.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, slug: true } })).filter((modpack) =>
            allows(user, Policies.modpack.update(modpack)),
        )
        const recent = await db.modpackImport.findMany({ orderBy: { id: 'desc' }, take: 50 })
        const recentModpacks = indexBy(await db.modpack.findMany({ where: { id: { in: recent.flatMap((r) => (r.modpack_id === null ? [] : [r.modpack_id])) } } }), (m) => m.id)
        const recentImports = recent
            .map((modpackImport) => ({ ...modpackImport, modpack: modpackImport.modpack_id === null ? null : (recentModpacks.get(modpackImport.modpack_id) ?? null) }))
            .filter((modpackImport) => allows(user, Policies.modpackImport.view(modpackImport, modpackImport.modpack)))
            .slice(0, 10)
            .map((modpackImport) => ({ ...modpackImport, problems: importProblems(modpackImport) }))
        await web.view('modpack.import', { modpacks, canCreate: allows(user, Policies.modpack.create()), recentImports })
    }

    @Post('import')
    async startImport(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        authorize(req.user, Policies.modpack.import())
        const source = web.input('source')
        const intoExisting = web.input('target') === 'existing'
        if (!intoExisting) {
            authorize(req.user, Policies.modpack.create())
        }
        const rules: Record<string, unknown> = { source: 'required|in:file,url', target: 'nullable|in:new,existing' }
        if (intoExisting) {
            rules.modpack_id = 'required|integer|exists:modpacks,id'
            rules.build_version = 'nullable|string|max:255'
        } else {
            rules.name = 'required'
            rules.slug = 'required|unique:modpacks|alpha_dash'
        }
        if (source === 'file') {
            rules.file = 'required|file'
        } else {
            rules.url = 'required|url'
        }
        const result = await validate(web.all(), rules as never, {}, { modpack_id: 'modpack' })
        if (!result.passes) {
            web.redirect('modpack/import').withErrors(result.errors).withInput().send()
            return
        }
        const modpack = intoExisting ? await db.modpack.findUnique({ where: { id: Number(web.input('modpack_id')) } }) : null
        if (modpack !== null) {
            authorize(req.user, Policies.modpack.update(modpack))
        }
        let archivePath: string | null = null
        const file = web.file('file')
        if (source === 'file' && file) {
            makeLocalDirectory('imports')
            archivePath = `imports/${uuid()}.${file.getClientOriginalExtension()}`
            file.storeAs(localPath('imports'), archivePath.slice('imports/'.length))
        }
        const modpackImport = await db.modpackImport.create({
            data: {
                user_id: web.userId,
                modpack_id: modpack?.id ?? null,
                name: modpack?.name ?? web.string('name'),
                slug: modpack === null ? toSlug(web.string('slug')) : null,
                source: source === 'file' && file ? file.getClientOriginalName() : web.string('url'),
                archive_path: archivePath,
                build_version: modpack !== null ? web.string('build_version').trim() || null : null,
                status: QUEUED,
            },
        })
        await this.runImport(web, modpackImport, web.redirect('modpack/import').withInput())
    }

    @Get('imports/:import_id')
    async importReport(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const id = routeId(req, 'import_id')
        const modpackImport = id === null ? null : await db.modpackImport.findUnique({ where: { id } })
        if (modpackImport === null) {
            web.redirect('modpack/import').withErrors(['Import not found']).send()
            return
        }
        const modpack = modpackImport.modpack_id === null ? null : await db.modpack.findUnique({ where: { id: modpackImport.modpack_id } })
        authorize(req.user, Policies.modpackImport.view(modpackImport, modpack))
        const user = modpackImport.user_id === null ? null : ((await usersByIds([modpackImport.user_id])).get(modpackImport.user_id) ?? null)
        const build = modpackImport.build_id === null ? null : await db.build.findUnique({ where: { id: modpackImport.build_id } })
        await web.view('modpack.import_report', {
            modpackImport: {
                ...modpackImport,
                modpack,
                user,
                build,
                log: importLog(modpackImport),
                problems: importProblems(modpackImport),
                archiveExists: archiveExists(modpackImport),
            },
        })
    }

    /** Decide what happens to an import waiting because its build version already exists */
    @Post('imports/:import_id')
    async decideImport(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const id = routeId(req, 'import_id')
        const modpackImport = id === null ? null : await db.modpackImport.findUnique({ where: { id } })
        if (modpackImport === null) {
            web.redirect('modpack/import').withErrors(['Import not found']).send()
            return
        }
        const modpack = modpackImport.modpack_id === null ? null : await db.modpack.findUnique({ where: { id: modpackImport.modpack_id } })
        authorize(req.user, Policies.modpackImport.update(modpack))
        const report = () => web.redirect(route('modpack.import.show', modpackImport.id))
        if (modpackImport.status !== WAITING) {
            report().withErrors(['This import is no longer waiting for a decision.']).send()
            return
        }
        const result = await validate(
            web.all(),
            {
                action: 'required|in:overwrite,rename,cancel',
                version: ['required_if:action,rename', 'nullable', 'string', 'max:255', Rule.unique('builds', 'version').whereEquals('modpack_id', modpackImport.modpack_id)],
            },
            { 'version.unique': 'This modpack already has a build :input too.' },
        )
        if (!result.passes) {
            report().withErrors(result.errors).withInput().send()
            return
        }
        const username = web.user.username
        const action = web.input('action')
        if (action === 'cancel') {
            await deleteArchive(modpackImport)
            await updateImport(modpackImport, { status: CANCELLED })
            await addLogEntry(modpackImport, 'info', `Cancelled by ${username}.`)
            report().with('success', 'Import cancelled. Nothing was changed.').send()
            return
        }
        if (action === 'overwrite') {
            await updateImport(modpackImport, { overwrite: true, status: QUEUED, problems: [] })
            await addLogEntry(modpackImport, 'info', `${username} chose to overwrite build ${modpackImport.build_version}.`)
        } else {
            const version = web.string('version').trim()
            await updateImport(modpackImport, { build_version: version, overwrite: false, status: QUEUED, problems: [] })
            await addLogEntry(modpackImport, 'info', `${username} chose to import it as build ${version} instead.`)
        }
        await this.runImport(web, modpackImport, report())
    }

    @Get('create')
    async create(@Req() req: Request, @Res() res: Response): Promise<void> {
        authorize(req.user, Policies.modpack.create())
        await Web.of(req, res).view('modpack.create')
    }

    @Post('create')
    async store(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        authorize(req.user, Policies.modpack.create())
        const result = await validate(web.all(), { name: 'required|unique:modpacks', slug: 'required|unique:modpacks', hidden: 'sometimes|required' }, MODPACK_MESSAGES)
        if (!result.passes) {
            web.redirect('modpack/create').withErrors(result.errors).send()
            return
        }
        const modpack = await db.modpack.create({
            data: {
                name: web.string('name'),
                slug: toSlug(web.string('slug')),
                hidden: web.boolean('hidden'),
                icon_md5: null,
                icon_url: appUrl('/resources/default/icon.png'),
                logo_md5: null,
                logo_url: appUrl('/resources/default/logo.png'),
                background_md5: null,
                background_url: appUrl('/resources/default/background.jpg'),
            },
        })
        await recordActivity('modpack.created', `Created modpack ${modpack.name}`, { modpack })
        await Cache.forget('modpacks', 'allmodpacks')
        if (web.user.permission) {
            await grantModpackAccess(web.user.permission, modpack.id)
        }
        web.redirect(`modpack/view/${modpack.id}`).send()
    }

    @Get('clone/:modpack_id')
    async cloneForm(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const modpack = await findModpack(req)
        if (!modpack) {
            web.redirect('modpack/list').withErrors(['Modpack not found']).send()
            return
        }
        authorize(req.user, Policies.modpack.create())
        authorize(req.user, Policies.modpack.update(modpack))
        await web.view('modpack.clone', { modpack: { ...modpack, builds: await buildsForModpack(modpack.id) } })
    }

    @Post('clone/:modpack_id')
    async clone(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const modpack = await findModpack(req)
        if (!modpack) {
            web.redirect('modpack/list').withErrors(['Modpack not found']).send()
            return
        }
        authorize(req.user, Policies.modpack.create())
        authorize(req.user, Policies.modpack.update(modpack))
        const slug = toSlug(web.string('slug'))
        const result = await validate(
            { ...web.all(), slug },
            { name: 'required|unique:modpacks', slug: 'required|unique:modpacks|alpha_dash', hidden: 'sometimes|required' },
            MODPACK_MESSAGES,
        )
        if (!result.passes) {
            web.redirect(`modpack/clone/${modpack.id}`).withErrors(result.errors).send()
            return
        }
        const newModpack = await cloneModpack(modpack, web.string('name'), slug, web.boolean('hidden'))
        if (web.user.permission) {
            await grantModpackAccess(web.user.permission, newModpack.id)
        }
        await Cache.forget('modpacks', 'allmodpacks')
        await recordActivity('modpack.created', `Cloned ${modpack.name} as ${newModpack.name}`, { modpack: newModpack })
        web.redirect(`modpack/view/${newModpack.id}`).send()
    }

    @Get('edit/:modpack_id')
    async edit(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const modpack = await findModpack(req)
        if (!modpack) {
            web.redirect('dashboard').withErrors(['Modpack not found']).send()
            return
        }
        authorize(req.user, Policies.modpack.update(modpack))
        await web.view('modpack.edit', {
            modpack: { ...modpack, hasPrivateBuilds: hasPrivateBuilds(await buildsForModpack(modpack.id)) },
            currentClients: (await clientsForModpack(modpack.id)).map((client) => client.id),
            allClients: await db.client.findMany({ orderBy: { id: 'asc' } }),
        })
    }

    @Post('edit/:modpack_id')
    async update(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const modpack = await findModpack(req)
        if (!modpack) {
            web.redirect('modpack/list/').withErrors(['Modpack not found']).send()
            return
        }
        authorize(req.user, Policies.modpack.update(modpack))
        const result = await validate(
            web.all(),
            { name: ['required', Rule.unique('modpacks', 'name').ignore(modpack.id)], slug: ['required', Rule.unique('modpacks', 'slug').ignore(modpack.id)] },
            MODPACK_MESSAGES,
        )
        if (!result.passes) {
            web.redirect(`modpack/edit/${modpack.id}`).withErrors(result.errors).send()
            return
        }
        const updated = await db.modpack.update({
            where: { id: modpack.id },
            data: { name: web.string('name'), slug: web.string('slug'), hidden: web.boolean('hidden'), private: web.boolean('private') },
        })
        await forgetModpack(modpack, 'modpacks', 'allmodpacks')
        if (modpack.slug !== updated.slug) {
            await Cache.forget(`modpack:${updated.slug}`)
        }
        // Client access
        const requested = web
            .array('clients')
            .map((id) => Number.parseInt(String(id), 10))
            .filter((id) => Number.isInteger(id) && id !== 0)
        const validClients = requested.length > 0 ? (await db.client.findMany({ where: { id: { in: requested } }, select: { id: true } })).map((client) => client.id) : []
        await syncClientModpacks({ modpack_id: modpack.id }, validClients)
        await recordActivity('modpack.edited', `Edited the details of ${updated.name}`, { modpack: updated })
        web.redirect(`modpack/edit/${modpack.id}`).with('success', 'Modpack saved').send()
    }

    @Get('delete/:modpack_id')
    async delete(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const modpack = await findModpack(req)
        if (!modpack) {
            web.redirect('modpack/list/').withErrors(['Modpack not found']).send()
            return
        }
        authorize(req.user, Policies.modpack.delete(modpack))
        await web.view('modpack.delete', { modpack })
    }

    @Post('delete/:modpack_id')
    async destroy(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const modpack = await findModpack(req)
        if (!modpack) {
            web.redirect('modpack/list/').withErrors(['Modpack not found']).send()
            return
        }
        authorize(req.user, Policies.modpack.delete(modpack))
        for (const build of await buildsForModpack(modpack.id)) {
            await db.buildModversion.deleteMany({ where: { build_id: build.id } })
            await Cache.forget(`modpack:${modpack.slug}:build:${build.version}`)
            await db.build.delete({ where: { id: build.id } })
        }
        await syncClientModpacks({ modpack_id: modpack.id }, [])
        await db.modpack.delete({ where: { id: modpack.id } })
        await recordActivity('modpack.deleted', `Deleted modpack ${modpack.name}`, { modpack })
        await forgetModpack(modpack, 'modpacks', 'allmodpacks', 'clients')
        web.redirect('modpack/list/').with('success', 'Modpack Deleted').send()
    }

    /** AJAX actions on the build and modpack pages */
    @Post('modify/:action')
    async modify(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        web.requireAjax()
        switch (req.params.action) {
            case 'version':
                return this.changeVersion(web)
            case 'delete':
                return this.removeVersion(web)
            case 'add':
                return this.addVersion(web)
            case 'recommended':
            case 'latest':
                return this.setModpackBuild(web, req.params.action)
            case 'published':
                return this.setPublished(web)
            case 'private':
                return this.setPrivate(web)
            case 'batch-version':
                return this.batchVersion(web)
            default:
                abort(400)
        }
    }

    /** Change a mod's version in a build */
    private async changeVersion(web: Web): Promise<void> {
        const versionId = Number(web.input('version'))
        const modversionId = Number(web.input('modversion_id'))
        const build = await this.ajaxBuild(web, 'build_id')
        authorize(web.req.user, Policies.build.update(build.modpack))
        let affected = 0
        if (Number.isInteger(versionId) && Number.isInteger(modversionId)) {
            affected = (await db.buildModversion.updateMany({ where: { build_id: build.id, modversion_id: modversionId }, data: { modversion_id: versionId } })).count
        }
        let status: string
        if (affected === 0) {
            status = String(web.input('modversion_id')) !== String(web.input('version')) ? 'failed' : 'aborted'
        } else {
            status = 'success'
            await Cache.forget(`modpack:${build.modpack.slug}:build:${build.version}`)
            await recordVersionChanges(build, [[modversionId, versionId]])
        }
        web.json({ status, reason: `Rows Affected: ${affected}` })
    }

    /** Remove a mod version from a build */
    private async removeVersion(web: Web): Promise<void> {
        const build = await this.ajaxBuild(web, 'build_id')
        authorize(web.req.user, Policies.build.update(build.modpack))
        const modversionId = Number(web.input('modversion_id'))
        const removed = Number.isInteger(modversionId) ? (await withMods(await db.modversion.findMany({ where: { id: modversionId } })))[0] : undefined
        const affected = Number.isInteger(modversionId) ? (await db.buildModversion.deleteMany({ where: { build_id: build.id, modversion_id: modversionId } })).count : 0
        if (affected > 0) {
            await Cache.forget(`modpack:${build.modpack.slug}:build:${build.version}`)
            if (removed) {
                await recordActivity('build.mod_removed', `Removed ${removed.mod.pretty_name} ${removed.version} from build ${build.version}`, {
                    build,
                    properties: { mod: removed.mod.name, version: removed.version },
                })
            }
        }
        web.json({ status: affected === 0 ? 'failed' : 'success', reason: `Rows Affected: ${affected}` })
    }

    /** Add a mod version to a build */
    private async addVersion(web: Web): Promise<void> {
        const build = await this.ajaxBuild(web, 'build')
        authorize(web.req.user, Policies.build.update(build.modpack))
        const mod = await db.mod.findUnique({ where: { name: web.string('mod-name') } })
        if (!mod) {
            abort(404)
        }
        const ver = await db.modversion.findFirst({ where: { mod_id: mod.id, version: web.string('mod-version') } })
        if (!ver) {
            web.json({ status: 'failed', reason: 'No such mod version exists' })
            return
        }
        if ((await modversionsForBuild(build.id)).some((modversion) => modversion.mod_id === mod.id)) {
            web.json({ status: 'failed', reason: 'This mod already exists in the build' })
            return
        }
        await db.buildModversion.create({ data: { build_id: build.id, modversion_id: ver.id } })
        await recordActivity('build.mod_added', `Added ${mod.pretty_name || mod.name} ${ver.version} to build ${build.version}`, {
            build,
            properties: { mod: mod.name, version: ver.version },
        })
        await forgetModpack(build.modpack, `modpack:${build.modpack.slug}:build:${build.version}`)
        const versions = await db.modversion.findMany({ where: { mod_id: mod.id }, orderBy: { id: 'asc' } })
        web.json({
            status: 'success',
            mod_id: mod.id,
            mod_name: mod.name,
            pretty_name: mod.pretty_name || mod.name,
            version: ver.version,
            modversion_id: ver.id,
            versions: versions.map((version) => ({ id: version.id, version: version.version })),
        })
    }

    /** Set the modpack's recommended or latest build */
    private async setModpackBuild(web: Web, which: 'recommended' | 'latest'): Promise<void> {
        const id = Number(web.input('modpack'))
        const modpack = Number.isInteger(id) ? await db.modpack.findUnique({ where: { id } }) : null
        if (!modpack) {
            abort(404)
        }
        authorize(web.req.user, Policies.modpack.update(modpack))
        const newVersion = web.input<string>(which)
        await db.modpack.update({ where: { id: modpack.id }, data: { [which]: newVersion === null ? null : String(newVersion) } })
        await recordActivity(`modpack.${which}`, `Set the ${which} build to ${newVersion ?? ''}`, { modpack })
        await forgetModpack(modpack)
        web.json({ success: `Updated ${modpack.name}'s ${which} build to ${newVersion ?? ''}`, version: newVersion })
    }

    /** Publish or unpublish a build */
    private async setPublished(web: Web): Promise<void> {
        const build = await this.ajaxBuild(web, 'build')
        authorize(web.req.user, Policies.build.update(build.modpack))
        // Check the build before it reaches players, unless the user already chose to publish anyway
        if (web.boolean('published') && !web.boolean('force')) {
            const errors = (await checkBuildHealth(build)).issues.filter((issue) => issue.severity === 'error')
            if (errors.length > 0) {
                web.json({
                    status: 'blocked',
                    reason: `Build ${build.version} has ${errors.length} ${plural('problem', errors.length)} that may stop it launching.`,
                    issues: errors.slice(0, 10).map((issue) => issue.message),
                })
                return
            }
        }
        const published = web.boolean('published')
        await db.build.update({ where: { id: build.id }, data: { is_published: published } })
        await forgetModpack(build.modpack, `modpack:${build.modpack.slug}:build:${build.version}`)
        const state = published ? 'published' : 'unpublished'
        await recordActivity(`build.${state}`, `${ucfirst(state)} build ${build.version}`, { build })
        if (published) {
            await DiscordNotifier.send(
                `${build.modpack.name} ${build.version} published`,
                `Published by ${web.user.username}.`,
                appUrl(`modpack/build/${build.id}`),
                DiscordNotifier.SUCCESS,
            )
        }
        web.json({ success: `Build ${build.version} is now ${state}` })
    }

    /** Make a build private or public */
    private async setPrivate(web: Web): Promise<void> {
        const build = await this.ajaxBuild(web, 'build')
        authorize(web.req.user, Policies.build.update(build.modpack))
        const isPrivate = web.boolean('private')
        await db.build.update({ where: { id: build.id }, data: { private: isPrivate } })
        await forgetModpack(build.modpack, `modpack:${build.modpack.slug}:build:${build.version}`)
        const state = isPrivate ? 'private' : 'public'
        await recordActivity(`build.${state}`, `Made build ${build.version} ${state}`, { build })
        web.json({ success: `Build ${build.version} is now ${state}` })
    }

    /** Change several mod versions in a build at once */
    private async batchVersion(web: Web): Promise<void> {
        const build = await this.ajaxBuild(web, 'build_id')
        authorize(web.req.user, Policies.build.update(build.modpack))
        const changes = web.input('changes') ?? []
        if (typeof changes !== 'object') {
            web.json({ status: 'error', reason: 'Invalid changes format' }, 422)
            return
        }
        const validated: { old: number; new: number }[] = []
        for (const change of Object.values(changes as object)) {
            const entry = change as Record<string, unknown> | null
            const isNumeric = (value: unknown) => value !== null && value !== undefined && value !== '' && !Number.isNaN(Number(value))
            if (entry === null || typeof entry !== 'object' || !isNumeric(entry.old_modversion_id) || !isNumeric(entry.new_modversion_id)) {
                web.json({ status: 'error', reason: 'Invalid change entry' }, 422)
                return
            }
            validated.push({ old: Math.trunc(Number(entry.old_modversion_id)), new: Math.trunc(Number(entry.new_modversion_id)) })
        }
        const updated = await db.$transaction(async (tx: TransactionClient) => {
            let count = 0
            for (const change of validated) {
                count += (await tx.buildModversion.updateMany({ where: { build_id: build.id, modversion_id: change.old }, data: { modversion_id: change.new } })).count
            }
            return count
        })
        await Cache.forget(`modpack:${build.modpack.slug}:build:${build.version}`)
        await recordVersionChanges(
            build,
            validated.map((change) => [change.old, change.new]),
        )
        web.json({ status: 'success', updated })
    }

    /** The build named by an AJAX request's input, or a 404 ($build = Build::findOrFail()) */
    private async ajaxBuild(web: Web, field: string): Promise<Build & { modpack: Modpack }> {
        const id = Number(web.input(field))
        const build = Number.isInteger(id) ? await db.build.findUnique({ where: { id } }) : null
        const modpack = build ? await db.modpack.findUnique({ where: { id: build.modpack_id } }) : null
        if (!build || !modpack) {
            abort(404)
        }
        return { ...build, modpack }
    }

    /**
     * Queue an import and follow it on a task page, or, when there's no queue worker and it has already finished,
     * go straight to the result.
     */
    private async runImport(web: Web, modpackImport: ModpackImport, onFailure: Redirect): Promise<void> {
        const taskId = await TaskTracker.create(web.userId, `Importing ${modpackImport.name}`)
        await runTask(ImportModpack, { taskId, importId: modpackImport.id })
        await followTask(web, taskId, onFailure)
    }
}

/** Log mod version changes in a build ([old modversion ID, new modversion ID] pairs) */
async function recordVersionChanges(build: Build, changes: [number, number][]): Promise<void> {
    const ids = changes.flat()
    const modversions = indexBy(await withMods(await db.modversion.findMany({ where: { id: { in: ids } } })), (modversion) => modversion.id)
    for (const [oldId, newId] of changes) {
        const oldVersion = modversions.get(oldId)
        const newVersion = modversions.get(newId)
        if (!oldVersion || !newVersion || oldVersion.id === newVersion.id) {
            continue
        }
        await recordActivity('build.mod_changed', `Changed ${newVersion.mod.pretty_name} from ${oldVersion.version} to ${newVersion.version} in build ${build.version}`, {
            build,
            properties: { mod: newVersion.mod.name, from: oldVersion.version, to: newVersion.version },
        })
    }
}

/** Copy a modpack, its builds and their mod assignments under a new name */
export async function cloneModpack(modpack: Modpack, name: string, slug: string, hidden: boolean): Promise<Modpack> {
    return db.$transaction(async (tx: TransactionClient) => {
        const created = await tx.modpack.create({
            data: {
                name,
                slug,
                hidden,
                private: modpack.private,
                recommended: modpack.recommended,
                latest: modpack.latest,
                icon: modpack.icon,
                icon_md5: modpack.icon_md5,
                icon_url: modpack.icon_url,
                logo: modpack.logo,
                logo_md5: modpack.logo_md5,
                logo_url: modpack.logo_url,
                background: modpack.background,
                background_md5: modpack.background_md5,
                background_url: modpack.background_url,
            },
        })
        for (const build of await buildsForModpack(modpack.id, tx)) {
            const newBuild = await tx.build.create({
                data: { modpack_id: created.id, ...(Object.fromEntries(BUILD_COPY_FIELDS.map((field) => [field, build[field]])) as Omit<Build, 'id' | 'modpack_id' | 'created_at' | 'updated_at'>) },
            })
            await syncBuildModversions(newBuild.id, await modversionIdsForBuild(build.id, tx), tx)
        }
        return created
    })
}

/** A CSV field as fputcsv() writes it */
function csvField(value: unknown): string {
    const text = String(value ?? '')
    return /[",\n\r\t ]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

