import { db } from '../database/prisma.js'
import { route } from '../http/urls.js'
import { repositoryPath } from '../models/modversion.js'
import { withMods } from '../models/relations.js'
import { DiscordNotifier } from '../services/discord-notifier.js'
import { ModRepository } from '../services/mod-repository.js'
import { TaskTracker } from '../services/task-tracker.js'
import { limit, plural } from '../support/str.js'
import { registerJob } from './queue.js'

/**
 * Compare every mod version's stored checksum and size with the file in the mod repository.
 */
export interface RepositoryProblem {
    modversion_id: number
    mod_id: number
    mod: string
    version: string
    path: string
    problem: 'missing' | 'changed'
    message: string
}

const CHUNK = 200

export const CheckModRepository = registerJob<{ taskId: string }>({
    name: 'CheckModRepository',
    async handle({ taskId }) {
        const total = await db.modversion.count()
        const problems: RepositoryProblem[] = []
        let checked = 0
        let cursor: number | undefined
        for (;;) {
            const page = await withMods(
                await db.modversion.findMany({
                    orderBy: [{ mod_id: 'asc' }, { id: 'asc' }],
                    take: CHUNK,
                    ...(cursor === undefined ? {} : { skip: 1, cursor: { id: cursor } }),
                }),
            )
            if (page.length === 0) {
                break
            }
            for (const modversion of page) {
                if (checked % 10 === 0) {
                    await TaskTracker.progress(taskId, checked, total, `Checking ${modversion.mod.pretty_name} ${modversion.version}`)
                }
                checked++
                const actual = await ModRepository.checksum(modversion)
                const problem = {
                    modversion_id: modversion.id,
                    mod_id: modversion.mod_id,
                    mod: modversion.mod.pretty_name || modversion.mod.name,
                    version: modversion.version,
                    path: repositoryPath(modversion.mod, modversion.version),
                }
                if (!actual.success) {
                    problems.push({ ...problem, problem: 'missing', message: actual.message })
                } else if (String(modversion.md5).toLowerCase() !== actual.md5.toLowerCase()) {
                    problems.push({ ...problem, problem: 'changed', message: 'The file differs from the stored checksum' })
                }
            }
            cursor = page[page.length - 1].id
            if (page.length < CHUNK) {
                break
            }
        }
        if (problems.length > 0) {
            await DiscordNotifier.send(
                `Mod repository check found ${problems.length} ${plural('problem', problems.length)}`,
                problems
                    .slice(0, 15)
                    .map((problem) => `${problem.mod} ${problem.version}: ${problem.message}`)
                    .join('\n'),
                route('solder.repository', { task: taskId }),
                DiscordNotifier.WARNING,
            )
        }
        await TaskTracker.complete(taskId, {
            url: route('solder.repository', { task: taskId }),
            label: 'View results',
            message: problems.length === 0 ? `All ${checked} mod versions match the files in the repository.` : `${problems.length} of ${checked} mod versions have a problem.`,
            problems,
            checked,
        })
    },
    async failed({ taskId }, error) {
        await TaskTracker.fail(taskId, `The check stopped unexpectedly: ${limit(error.message, 300)}`)
    },
})
