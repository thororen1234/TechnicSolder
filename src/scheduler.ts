import { config } from './config.js'
import { connectDatabase } from './database/prisma.js'
import { SCHEDULE } from './jobs/schedule.js'
import { Cache } from './support/cache.js'
import { logger } from './support/logger.js'

/**
 * The scheduler process (Laravel's schedule:work): checks every minute whether a task in SCHEDULE is due.
 */
function localTime(date: Date): { day: string; hour: number; minute: number } {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-CA', { timeZone: config.app.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
            .formatToParts(date)
            .map((part) => [part.type, part.value]),
    )
    return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) }
}

async function tick(): Promise<void> {
    const now = localTime(new Date())
    for (const task of SCHEDULE) {
        if (!task.enabled() || now.hour !== task.at[0] || now.minute !== task.at[1]) {
            continue
        }
        // withoutOverlapping() / one run per day, shared by every scheduler process
        const key = `schedule:${task.name}:${now.day}`
        if (await Cache.has(key)) {
            continue
        }
        await Cache.put(key, true, 86400)
        logger.info(`Running scheduled task ${task.name}`)
        task.run().catch((error) => logger.report(error))
    }
}

await connectDatabase()
logger.info('Scheduler started')
await tick()
setInterval(() => void tick(), 60_000)
