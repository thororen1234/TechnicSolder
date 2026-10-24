import { db } from '../database/prisma.js'
import { currentUserId } from '../http/context.js'
import type { ActivityLog, Build, Modpack } from './types.js'

/**
 * A record of a change to a modpack or build: who did what, and when.
 *
 * Modpacks and builds keep their history after being deleted, so the IDs are not foreign keys.
 */
export interface RecordOptions {
    modpack?: Pick<Modpack, 'id'> | null
    build?: Pick<Build, 'id' | 'modpack_id'> | null
    properties?: Record<string, unknown>
    /** Defaults to whoever is signed in (web session or API token) */
    userId?: number | null
}

export async function recordActivity(action: string, description: string, options: RecordOptions = {}): Promise<ActivityLog> {
    const properties = options.properties && Object.keys(options.properties).length > 0 ? options.properties : null
    return db.activityLog.create({
        data: {
            user_id: options.userId ?? currentUserId(),
            modpack_id: options.modpack?.id ?? options.build?.modpack_id ?? null,
            build_id: options.build?.id ?? null,
            action,
            description,
            properties: properties === null ? null : JSON.stringify(properties),
        },
    })
}

export function activityProperties(log: Pick<ActivityLog, 'properties'>): Record<string, unknown> | null {
    return log.properties ? (JSON.parse(log.properties) as Record<string, unknown>) : null
}
