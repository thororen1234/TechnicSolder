import { config } from '../config.js'
import { cancelAbandonedImports } from '../models/modpack-import.js'
import { CheckAllBuildUpdates } from './check-all-build-updates.js'
import { dispatch } from './queue.js'

/**
 * Scheduled tasks (Laravel's schedule): the nightly mod update check at 04:00 and the daily clean-up of imports
 * nobody decided on. Times are in APP_TIMEZONE. Run by `pnpm scheduler`.
 */
export interface ScheduledTask {
    name: string
    /** Hour and minute of day to run, in APP_TIMEZONE */
    at: [number, number]
    enabled: () => boolean
    run: () => Promise<unknown>
}

export const SCHEDULE: ScheduledTask[] = [
    {
        name: 'solder:check-updates',
        at: [4, 0],
        enabled: () => config.solder.scheduled_update_checks,
        run: () => dispatch(CheckAllBuildUpdates, { taskId: null }),
    },
    {
        name: 'cancel-abandoned-imports',
        at: [0, 0],
        enabled: () => true,
        run: () => cancelAbandonedImports(),
    },
]
