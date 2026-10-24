import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { config, isTesting } from '../config.js'
import { toIso8601String } from './dates.js'

/**
 * Writes to storage/logs/solder.log (like Laravel's single log channel) and to the console.
 */
type Level = 'debug' | 'info' | 'warning' | 'error'

function write(level: Level, message: string): void {
    const line = `[${toIso8601String()}] ${config.app.env}.${level.toUpperCase()}: ${message}\n`
    if (!isTesting()) {
        try {
            const directory = join(config.paths.root, 'storage/logs')
            mkdirSync(directory, { recursive: true })
            appendFileSync(join(directory, 'solder.log'), line)
        } catch {
            // The log is best-effort
        }
        ;(level === 'error' ? console.error : console.log)(line.trimEnd())
    }
}

export const logger = {
    debug: (message: string) => write('debug', message),
    info: (message: string) => write('info', message),
    warn: (message: string) => write('warning', message),
    error: (message: string) => write('error', message),
    /** report(): log an unexpected error without failing what triggered it */
    report: (error: unknown) => write('error', error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)),
}
