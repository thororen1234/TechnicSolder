import { existsSync, rmSync } from 'node:fs'
import { db } from '../database/prisma.js'
import { localPath } from '../support/storage.js'
import { subDays, toIso8601String } from '../support/dates.js'
import type { ModpackImport } from './types.js'

/**
 * One modpack import: where it came from, what it went into, the problems it hit and a log of what it did.
 *
 * An import into an existing modpack that already has the build version stops as "waiting" and keeps its archive
 * until someone overwrites the build, imports it under another version or cancels. Like activity logs, imports
 * keep their history after the modpack or build is deleted, so the IDs are not foreign keys.
 */
export const QUEUED = 'queued'
export const RUNNING = 'running'
export const WAITING = 'waiting'
export const COMPLETED = 'completed'
export const FAILED = 'failed'
export const CANCELLED = 'cancelled'

/** Imports waiting for a decision are cancelled, and their archives deleted, after this many days */
export const WAITING_DAYS = 7

export interface LogEntry {
    time: string
    level: 'info' | 'error'
    message: string
}

export function importProblems(modpackImport: Pick<ModpackImport, 'problems'>): string[] {
    return modpackImport.problems ? (JSON.parse(modpackImport.problems) as string[]) : []
}

export function importLog(modpackImport: Pick<ModpackImport, 'log'>): LogEntry[] {
    return modpackImport.log ? (JSON.parse(modpackImport.log) as LogEntry[]) : []
}

export type ImportChanges = Partial<Omit<ModpackImport, 'problems'>> & { problems?: string[] }

export async function updateImport(modpackImport: ModpackImport, changes: ImportChanges): Promise<ModpackImport> {
    const { problems, ...rest } = changes
    const data = { ...rest, ...(problems !== undefined ? { problems: JSON.stringify(problems) } : {}) }
    const updated = await db.modpackImport.update({ where: { id: modpackImport.id }, data })
    Object.assign(modpackImport, updated)
    return modpackImport
}

export async function addLogEntry(modpackImport: ModpackImport, level: LogEntry['level'], message: string): Promise<void> {
    const current = await db.modpackImport.findUnique({ where: { id: modpackImport.id }, select: { log: true } })
    const log = [...importLog(current ?? modpackImport), { time: toIso8601String(), level, message }]
    await updateImport(modpackImport, { log: JSON.stringify(log) })
}

export function isFinished(modpackImport: Pick<ModpackImport, 'status'>): boolean {
    return [COMPLETED, FAILED, CANCELLED].includes(modpackImport.status)
}

export function archiveExists(modpackImport: Pick<ModpackImport, 'archive_path'>): boolean {
    return modpackImport.archive_path !== null && existsSync(localPath(modpackImport.archive_path))
}

export async function deleteArchive(modpackImport: ModpackImport): Promise<void> {
    if (modpackImport.archive_path !== null) {
        rmSync(localPath(modpackImport.archive_path), { force: true })
        await updateImport(modpackImport, { archive_path: null })
    }
}

/** Cancel imports nobody decided on within WAITING_DAYS, freeing their archives. Returns how many. */
export async function cancelAbandonedImports(): Promise<number> {
    const abandoned = await db.modpackImport.findMany({ where: { status: WAITING, updated_at: { lt: subDays(WAITING_DAYS) } } })
    for (const modpackImport of abandoned) {
        await deleteArchive(modpackImport)
        await updateImport(modpackImport, { status: CANCELLED })
        await addLogEntry(modpackImport, 'info', `Cancelled after waiting ${WAITING_DAYS} days for a decision.`)
    }
    return abandoned.length
}
