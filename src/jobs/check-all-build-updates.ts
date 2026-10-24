import { appUrl } from '../http/urls.js'
import { BuildUpdateService, type UpdateSummary } from '../services/build-update.js'
import { DiscordNotifier } from '../services/discord-notifier.js'
import { TaskTracker, taskProgress } from '../services/task-tracker.js'
import { limit, plural } from '../support/str.js'
import { registerJob } from './queue.js'

/**
 * Check every modpack's latest build for updates, show the results on the dashboard and post them to Discord.
 */
export interface CheckAllBuildUpdatesPayload {
    /** Task to report progress to, when started from the dashboard */
    taskId: string | null
}

export async function checkAllBuildUpdates(taskId: string | null): Promise<UpdateSummary> {
    const service = new BuildUpdateService(taskId === null ? null : taskProgress(taskId))
    const summary = await service.checkAllModpacks()
    if (summary.builds.length > 0) {
        const lines = summary.builds.map(
            (build) => `**${build.modpack}** ${build.build}: ${build.count} ${plural('update', build.count)} (${limit(build.mods.join(', '), 120)})`,
        )
        await DiscordNotifier.send(
            `Mod updates available for ${summary.builds.length} ${plural('modpack', summary.builds.length)}`,
            lines.join('\n'),
            appUrl('dashboard'),
            DiscordNotifier.WARNING,
        )
    }
    if (taskId !== null) {
        const count = summary.builds.length
        await TaskTracker.complete(taskId, {
            url: appUrl('dashboard'),
            label: 'Back to the overview',
            message: count === 0 ? 'Every modpack is up to date.' : `${count} ${plural('modpack', count)}${count === 1 ? ' has' : ' have'} updates available.`,
        })
    }
    return summary
}

export const CheckAllBuildUpdates = registerJob<CheckAllBuildUpdatesPayload>({
    name: 'CheckAllBuildUpdates',
    handle: ({ taskId }) => checkAllBuildUpdates(taskId),
    async failed({ taskId }, error) {
        if (taskId !== null) {
            await TaskTracker.fail(taskId, `The update check stopped unexpectedly: ${limit(error.message, 300)}`)
        }
    },
})
