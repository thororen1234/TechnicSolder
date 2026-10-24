import { Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common'
import type { Request, Response } from 'express'
import { db } from '../database/prisma.js'
import { AuthGuard } from '../http/guards.js'
import { route } from '../http/urls.js'
import { Web } from '../http/web.js'
import { CheckAllBuildUpdates } from '../jobs/check-all-build-updates.js'
import { runTask } from '../jobs/queue.js'
import { canAccessModpack, modpackIds } from '../models/permissions.js'
import { modpacksByIds, modversionCounts, unusedModversionIds, withMods } from '../models/relations.js'
import { SUMMARY_CACHE_KEY, type UpdateSummary } from '../services/build-update.js'
import { TaskTracker } from '../services/task-tracker.js'
import { getLatestChangeLog, isGithubError } from '../services/update-utils.js'
import { Cache } from '../support/cache.js'

@Controller()
@UseGuards(AuthGuard)
export class DashboardController {
    @Get('dashboard')
    async index(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const permission = web.user.permission
        const builds = await db.build.findMany({
            where: { is_published: true, ...(permission?.solder_full ? {} : { modpack_id: { in: modpackIds(permission) } }) },
            orderBy: { updated_at: 'desc' },
            take: 5,
        })
        const modpacks = await modpacksByIds(builds.map((build) => build.modpack_id))
        const counts = await modversionCounts(builds.map((build) => build.id))
        const modversions = await withMods(await db.modversion.findMany({ orderBy: { updated_at: 'desc' }, take: 5 }))
        const unusedModversions = await withMods(
            await db.modversion.findMany({ where: { id: { in: await unusedModversionIds() } }, orderBy: { created_at: 'desc' }, take: 20 }),
        )
        const rawChangeLog = await getLatestChangeLog()
        const changelog = isGithubError(rawChangeLog) ? rawChangeLog : rawChangeLog.slice(0, 10)

        // Results of the last update check, limited to the modpacks this user manages
        const updateSummary = await Cache.get<UpdateSummary>(SUMMARY_CACHE_KEY)
        if (updateSummary !== null && !permission?.solder_full) {
            updateSummary.builds = updateSummary.builds.filter((build) => canAccessModpack(permission, build.modpack_id))
        }

        await web.view('dashboard.index', {
            modversions,
            builds: builds
                .filter((build) => modpacks.has(build.modpack_id))
                .map((build) => ({ ...build, modpack: modpacks.get(build.modpack_id), modversions_count: counts.get(build.id) ?? 0 })),
            unusedModversions,
            changelog,
            updateSummary,
        })
    }

    /** Run the update check for every modpack now instead of waiting for the nightly run */
    @Post('dashboard/check-updates')
    async checkUpdates(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const taskId = await TaskTracker.create(web.userId, 'Checking every modpack for mod updates')
        await runTask(CheckAllBuildUpdates, { taskId })
        const task = await TaskTracker.get(taskId)
        if (task?.status === 'completed') {
            web.redirect('dashboard').with('success', task.result?.message).send()
            return
        }
        web.redirect(route('task.show', taskId)).send()
    }
}
