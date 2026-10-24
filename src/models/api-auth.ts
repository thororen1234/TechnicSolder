import { timingSafeEqual } from 'node:crypto'
import { db } from '../database/prisma.js'
import { Cache, MINUTE } from '../support/cache.js'
import { modpackIdsForClient } from './relations.js'
import type { Client, Key, UserWithPermission } from './types.js'

/**
 * Who a launcher API request is from: a client (?cid=), a platform key (?k=) and/or a user (bearer token).
 */
export interface ApiAuthContext {
    client: (Client & { modpackIds: number[] }) | null
    key: Key | null
    user: UserWithPermission | null
}

export function hashEquals(known: string, input: string): boolean {
    const a = Buffer.from(String(known))
    const b = Buffer.from(String(input))
    return a.length === b.length && timingSafeEqual(a, b)
}

export async function cachedKeys(): Promise<Key[]> {
    return Cache.remember('keys', MINUTE, () => db.key.findMany({ orderBy: { id: 'asc' } }))
}

export async function cachedClients(): Promise<Client[]> {
    return Cache.remember('clients', MINUTE, () => db.client.findMany({ orderBy: { id: 'asc' } }))
}

export async function apiAuthContext(input: { cid?: unknown; k?: unknown }, user: UserWithPermission | null): Promise<ApiAuthContext> {
    let client: ApiAuthContext['client'] = null
    if (typeof input.cid === 'string' && input.cid !== '') {
        const match = (await cachedClients()).find((c) => hashEquals(c.uuid, input.cid as string))
        if (match) {
            client = { ...match, modpackIds: await modpackIdsForClient(match.id) }
        }
    }
    let key: Key | null = null
    if (typeof input.k === 'string' && input.k !== '') {
        key = (await cachedKeys()).find((k) => hashEquals(k.api_key, input.k as string)) ?? null
    }
    return { client, key, user }
}
