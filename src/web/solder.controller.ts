import { Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common'
import type { Request, Response } from 'express'
import { config, SOLDER_VERSION } from '../config.js'
import { db } from '../database/prisma.js'
import { abort } from '../http/errors.js'
import { AuthGuard } from '../http/guards.js'
import { appUrl, route } from '../http/urls.js'
import { Web } from '../http/web.js'
import { CheckModRepository } from '../jobs/check-mod-repository.js'
import { runTask } from '../jobs/queue.js'
import { modpackIds } from '../models/permissions.js'
import { buildsByIds, modpacksByIds, usersByIds, withMods } from '../models/relations.js'
import type { ActivityLog } from '../models/types.js'
import { authorize, Policies } from '../policies/gate.js'
import { DiscordNotifier } from '../services/discord-notifier.js'
import { getMinecraftVersions } from '../services/minecraft.js'
import { ModRepository } from '../services/mod-repository.js'
import { TaskTracker, type Task } from '../services/task-tracker.js'
import { getLatestChangeLog, getLatestVersion, getUpdateCheck, isGithubError } from '../services/update-utils.js'
import { Cache, HOUR } from '../support/cache.js'
import { localExists, localPath } from '../support/storage.js'
import { plural, isUuid } from '../support/str.js'
import { Paginator } from '../views/paginator.js'

/** Activity entries with their user, modpack and build, for the activity lists */
export async function withActivityRelations(entries: ActivityLog[]) {
    const users = await usersByIds(entries.map((entry) => entry.user_id))
    const modpacks = await modpacksByIds(entries.map((entry) => entry.modpack_id).filter((id): id is number => id !== null))
    const builds = await buildsByIds(entries.map((entry) => entry.build_id))
    return entries.map((entry) => ({
        ...entry,
        user: entry.user_id === null ? null : (users.get(entry.user_id) ?? null),
        modpack: entry.modpack_id === null ? null : (modpacks.get(entry.modpack_id) ?? null),
        build: entry.build_id === null ? null : (builds.get(entry.build_id) ?? null),
    }))
}

/** A task the signed-in user started, or a 404 (tasks are only visible to the user who started them) */
async function findTask(web: Web, taskId: string): Promise<Task> {
    const task = isUuid(taskId) ? await TaskTracker.get(taskId) : null
    if (task === null || task.user_id !== web.userId) {
        abort(404)
    }
    return task
}

@Controller()
@UseGuards(AuthGuard)
export class TaskController {
    @Get('task/:taskId')
    async show(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        await web.view('task.show', { task: await findTask(web, req.params.taskId as string) })
    }

    @Get('task/:taskId/status')
    async status(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const taskId = req.params.taskId as string
        const task = await findTask(web, taskId)
        const result = task.result ?? {}
        web.json({
            status: task.status,
            done: task.done,
            total: task.total,
            message: task.message,
            errors: task.errors,
            url: result.url ?? (result.path !== undefined ? route('task.download', taskId) : null),
            label: result.label ?? null,
            download: result.path !== undefined,
            redirect: Boolean(result.redirect),
            report_url: result.report_url ?? null,
        })
    }

    @Get('task/:taskId/download')
    async download(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const task = await findTask(web, req.params.taskId as string)
        const path = typeof task.result?.path === 'string' ? task.result.path : null
        if (path === null || !localExists(path)) {
            abort(404, 'This export has expired. Export the build again.')
        }
        await web.download(localPath(path), String(task.result?.filename))
    }
}

@Controller('solder')
@UseGuards(AuthGuard)
export class SolderController {
    @Get('configure')
    async configure(@Req() req: Request, @Res() res: Response): Promise<void> {
        await Web.of(req, res).view('solder.configure', { minecraftCached: await Cache.has('minecraftversions') })
    }

    @Post('notifications/test')
    async testNotification(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        if (!DiscordNotifier.isConfigured()) {
            web.redirect('solder/configure').withErrors(['Set SOLDER_DISCORD_WEBHOOK, or SOLDER_DISCORD_BOT_TOKEN and SOLDER_DISCORD_USER_ID, in your .env file first.']).send()
            return
        }
        const sent = await DiscordNotifier.send('Test message from Technic Solder', 'Notifications are working.', appUrl('dashboard'), DiscordNotifier.SUCCESS)
        if (sent) {
            web.redirect('solder/configure').with('success', 'Test message sent to Discord.').send()
            return
        }
        web.redirect('solder/configure')
            .withErrors([
                'Discord did not accept the message. Check the webhook URL, bot token and user IDs, and that the bot shares a server with each user; details are in the log.',
            ])
            .send()
    }

    /** Everything that changed, newest first. Users without full access only see modpacks they can manage. */
    @Get('activity')
    async activity(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const permission = web.user.permission
        const modpackFilter = web.query('modpack')
        const where = {
            ...(permission?.solder_full ? {} : { modpack_id: { in: modpackIds(permission) } }),
            ...(modpackFilter ? { AND: [{ modpack_id: Number(modpackFilter) || -1 }] } : {}),
        }
        const perPage = 50
        const page = Math.max(1, Number.parseInt(web.query('page') ?? '1', 10) || 1)
        const total = await db.activityLog.count({ where })
        const entries = await db.activityLog.findMany({ where, orderBy: { id: 'desc' }, skip: (page - 1) * perPage, take: perPage })
        const query = new URLSearchParams(req.query as Record<string, string>)
        query.set('page', '{page}')
        const pattern = `${appUrl('solder/activity')}?${query.toString().replace('%7Bpage%7D', '{page}')}`
        await web.view('solder.activity', { entries: Paginator.paginate(await withActivityRelations(entries), total, page, perPage, pattern) })
    }

    /** Mod repository check: results of a previous run (?task=...) or a button to start one */
    @Get('repository')
    async repository(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        authorize(req.user, Policies.modversion.update())
        const taskId = web.query('task')
        let task = taskId && isUuid(taskId) ? await TaskTracker.get(taskId) : null
        if (task !== null && task.user_id !== web.userId) {
            task = null
        }
        await web.view('solder.repository', {
            task,
            isRemote: ModRepository.isRemote(),
            location: config.solder.repo_location,
            modversionCount: await db.modversion.count(),
        })
    }

    @Post('repository')
    async startRepositoryCheck(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        authorize(req.user, Policies.modversion.update())
        const taskId = await TaskTracker.create(web.userId, 'Checking the mod repository')
        await runTask(CheckModRepository, { taskId })
        const task = await TaskTracker.get(taskId)
        web.redirect(task?.status === 'completed' ? route('solder.repository', { task: taskId }) : route('task.show', taskId)).send()
    }

    /** Store the current checksum and size of files that changed on purpose */
    @Post('repository/fix')
    async fixRepository(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        authorize(req.user, Policies.modversion.update())
        let updated = 0
        const errors: string[] = []
        const ids = web.array('modversions').map(Number).filter(Number.isInteger)
        for (const modversion of await withMods(await db.modversion.findMany({ where: { id: { in: ids } } }))) {
            const actual = await ModRepository.checksum(modversion)
            if (!actual.success) {
                errors.push(`${modversion.mod.name} ${modversion.version}: ${actual.message}`)
                continue
            }
            await db.modversion.update({ where: { id: modversion.id }, data: { md5: actual.md5, filesize: actual.filesize } })
            updated++
        }
        const taskId = web.string('task')
        const redirect = web
            .redirect(route('solder.repository', taskId ? { task: taskId } : {}))
            .with('success', `Updated the stored checksum of ${updated} mod ${plural('version', updated)}.`)
        if (errors.length > 0) {
            redirect.withErrors(errors)
        }
        redirect.send()
    }

    @Get('update')
    async update(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const rawChangeLog = await getLatestChangeLog()
        const changelog = isGithubError(rawChangeLog) ? rawChangeLog : rawChangeLog.slice(0, 10)
        const latestCommit = isGithubError(rawChangeLog) ? rawChangeLog : (rawChangeLog[0] ?? { error: 'No commits found' })
        const rawLatestVersion = await getLatestVersion()
        const latestVersion = isGithubError(rawLatestVersion) ? rawLatestVersion : rawLatestVersion.name
        await web.view('solder.update', { changelog, currentVersion: SOLDER_VERSION, latestData: { version: latestVersion, commit: latestCommit } })
    }

    @Get('update-check')
    async updateCheck(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        web.requireAjax()
        if (await getUpdateCheck(true)) {
            await Cache.put('update', true, HOUR)
            web.json({ success: true, update: true })
            return
        }
        await Cache.forget('update')
        web.json({ success: true, update: false })
    }

    @Get('cache-minecraft')
    async cacheMinecraft(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        web.requireAjax()
        let versions
        try {
            versions = await getMinecraftVersions(true)
        } catch (error) {
            web.json({ success: false, message: (error as Error).message })
            return
        }
        // Sanity check in case the refetch fails
        if (versions.length === 0) {
            web.json({ success: false, message: 'Fetch failed, check the Solder logs' })
            return
        }
        web.json({ success: true })
    }
}
