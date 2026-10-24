import { db, type Db } from '../database/prisma.js'
import type { Build, Client, Mod, Modpack, Modversion, ModversionWithMod, User, UserPermission, UserWithPermission } from './types.js'

/**
 * Loading related rows. The schema declares no Prisma relations (see prisma/schema.prisma), so these do what
 * Eloquent's eager loading did: one query per relation, matched up in memory. Rows whose related row is
 * missing are left out rather than failing.
 */

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
    const groups = new Map<K, T[]>()
    for (const item of items) {
        const k = key(item)
        const group = groups.get(k)
        if (group) {
            group.push(item)
        } else {
            groups.set(k, [item])
        }
    }
    return groups
}

export function indexBy<T, K>(items: T[], key: (item: T) => K): Map<K, T> {
    return new Map(items.map((item) => [key(item), item]))
}

/** Attach each mod version's mod */
export async function withMods(modversions: Modversion[], client: Db = db): Promise<ModversionWithMod[]> {
    if (modversions.length === 0) {
        return []
    }
    const mods = indexBy(
        await client.mod.findMany({ where: { id: { in: [...new Set(modversions.map((mv) => mv.mod_id))] } } }),
        (mod) => mod.id,
    )
    return modversions.flatMap((mv) => {
        const mod = mods.get(mv.mod_id)
        return mod ? [{ ...mv, mod }] : []
    })
}

/** Mod versions of each build, with their mods, ordered by pivot row (insertion order) */
export async function modversionsForBuilds(buildIds: number[], client: Db = db): Promise<Map<number, ModversionWithMod[]>> {
    const result = new Map<number, ModversionWithMod[]>(buildIds.map((id) => [id, []]))
    if (buildIds.length === 0) {
        return result
    }
    const pivots = await client.buildModversion.findMany({ where: { build_id: { in: buildIds } }, orderBy: { id: 'asc' } })
    const modversions = indexBy(
        await withMods(await client.modversion.findMany({ where: { id: { in: [...new Set(pivots.map((p) => p.modversion_id))] } } }), client),
        (mv) => mv.id,
    )
    for (const pivot of pivots) {
        const modversion = modversions.get(pivot.modversion_id)
        if (modversion) {
            result.get(pivot.build_id)?.push(modversion)
        }
    }
    return result
}

export async function modversionsForBuild(buildId: number, client: Db = db): Promise<ModversionWithMod[]> {
    return (await modversionsForBuilds([buildId], client)).get(buildId) ?? []
}

/** IDs of the mod versions in a build */
export async function modversionIdsForBuild(buildId: number, client: Db = db): Promise<number[]> {
    const pivots = await client.buildModversion.findMany({ where: { build_id: buildId }, orderBy: { id: 'asc' }, select: { modversion_id: true } })
    return pivots.map((pivot) => pivot.modversion_id)
}

/** Number of mod versions in each build ($builds->withCount('modversions')) */
export async function modversionCounts(buildIds: number[], client: Db = db): Promise<Map<number, number>> {
    const counts = new Map<number, number>(buildIds.map((id) => [id, 0]))
    if (buildIds.length === 0) {
        return counts
    }
    const grouped = await client.buildModversion.groupBy({ by: ['build_id'], where: { build_id: { in: buildIds } }, _count: { _all: true } })
    for (const row of grouped) {
        counts.set(row.build_id, row._count._all)
    }
    return counts
}

/** Builds of a modpack */
export async function buildsForModpack(modpackId: number, client: Db = db): Promise<Build[]> {
    return client.build.findMany({ where: { modpack_id: modpackId }, orderBy: { id: 'asc' } })
}

export async function buildsForModpacks(modpackIds: number[], client: Db = db): Promise<Map<number, Build[]>> {
    const builds = await client.build.findMany({ where: { modpack_id: { in: modpackIds } }, orderBy: { id: 'asc' } })
    const grouped = groupBy(builds, (build) => build.modpack_id)
    return new Map(modpackIds.map((id) => [id, grouped.get(id) ?? []]))
}

/** Versions of a mod, oldest first */
export async function versionsForMod(modId: number, client: Db = db): Promise<Modversion[]> {
    return client.modversion.findMany({ where: { mod_id: modId }, orderBy: { id: 'asc' } })
}

export async function versionsForMods(modIds: number[], client: Db = db): Promise<Map<number, Modversion[]>> {
    const versions = await client.modversion.findMany({ where: { mod_id: { in: modIds } }, orderBy: { id: 'asc' } })
    const grouped = groupBy(versions, (version) => version.mod_id)
    return new Map(modIds.map((id) => [id, grouped.get(id) ?? []]))
}

/** Builds that use each mod version */
export async function buildsForModversions(modversionIds: number[], client: Db = db): Promise<Map<number, Build[]>> {
    const result = new Map<number, Build[]>(modversionIds.map((id) => [id, []]))
    if (modversionIds.length === 0) {
        return result
    }
    const pivots = await client.buildModversion.findMany({ where: { modversion_id: { in: modversionIds } }, orderBy: { id: 'asc' } })
    const builds = indexBy(await client.build.findMany({ where: { id: { in: [...new Set(pivots.map((p) => p.build_id))] } } }), (b) => b.id)
    for (const pivot of pivots) {
        const build = builds.get(pivot.build_id)
        if (build) {
            result.get(pivot.modversion_id)?.push(build)
        }
    }
    return result
}

/** IDs of mod versions that no build uses ($query->doesntHave('builds')) */
export async function unusedModversionIds(client: Db = db): Promise<number[]> {
    const rows = await client.$queryRawUnsafe<{ id: number | bigint }[]>(
        'SELECT id FROM modversions WHERE NOT EXISTS (SELECT 1 FROM build_modversion WHERE build_modversion.modversion_id = modversions.id)',
    )
    return rows.map((row) => Number(row.id))
}

export async function modpacksByIds(ids: number[], client: Db = db): Promise<Map<number, Modpack>> {
    const unique = [...new Set(ids.filter((id): id is number => id !== null && id !== undefined))]
    if (unique.length === 0) {
        return new Map()
    }
    return indexBy(await client.modpack.findMany({ where: { id: { in: unique } } }), (modpack) => modpack.id)
}

export async function buildsByIds(ids: (number | null)[], client: Db = db): Promise<Map<number, Build>> {
    const unique = [...new Set(ids.filter((id): id is number => id !== null && id !== undefined))]
    if (unique.length === 0) {
        return new Map()
    }
    return indexBy(await client.build.findMany({ where: { id: { in: unique } } }), (build) => build.id)
}

export async function usersByIds(ids: (number | null)[], client: Db = db): Promise<Map<number, User>> {
    const unique = [...new Set(ids.filter((id): id is number => id !== null && id !== undefined))]
    if (unique.length === 0) {
        return new Map()
    }
    return indexBy(await client.user.findMany({ where: { id: { in: unique } } }), (user) => user.id)
}

export async function modsByIds(ids: number[], client: Db = db): Promise<Map<number, Mod>> {
    return indexBy(await client.mod.findMany({ where: { id: { in: [...new Set(ids)] } } }), (mod) => mod.id)
}

/** Modpacks a client has been given access to */
export async function modpackIdsForClient(clientId: number, client: Db = db): Promise<number[]> {
    const pivots = await client.clientModpack.findMany({ where: { client_id: clientId }, orderBy: { id: 'asc' } })
    return pivots.map((pivot) => pivot.modpack_id)
}

export async function clientsForModpack(modpackId: number, client: Db = db): Promise<Client[]> {
    const pivots = await client.clientModpack.findMany({ where: { modpack_id: modpackId } })
    return client.client.findMany({ where: { id: { in: pivots.map((pivot) => pivot.client_id) } }, orderBy: { id: 'asc' } })
}

export async function permissionFor(userId: number, client: Db = db): Promise<UserPermission | null> {
    return client.userPermission.findFirst({ where: { user_id: userId }, orderBy: { id: 'asc' } })
}

export async function withPermission(user: User, client: Db = db): Promise<UserWithPermission> {
    return { ...user, permission: await permissionFor(user.id, client) }
}

export async function findUserWithPermission(id: number, client: Db = db): Promise<UserWithPermission | null> {
    const user = await client.user.findUnique({ where: { id } })
    return user ? withPermission(user, client) : null
}

/**
 * Replace the pivot rows linking one row to others ($relation->sync($ids)), keeping the rows that stay.
 */
export async function syncBuildModversions(buildId: number, modversionIds: number[], client: Db = db): Promise<void> {
    const wanted = [...new Set(modversionIds.map(Number))]
    const current = await client.buildModversion.findMany({ where: { build_id: buildId } })
    const currentIds = new Set(current.map((pivot) => pivot.modversion_id))
    const remove = current.filter((pivot) => !wanted.includes(pivot.modversion_id)).map((pivot) => pivot.id)
    if (remove.length > 0) {
        await client.buildModversion.deleteMany({ where: { id: { in: remove } } })
    }
    const add = wanted.filter((id) => !currentIds.has(id))
    if (add.length > 0) {
        await client.buildModversion.createMany({ data: add.map((modversion_id) => ({ build_id: buildId, modversion_id })) })
    }
}

export async function syncClientModpacks(where: { client_id: number } | { modpack_id: number }, ids: number[], client: Db = db): Promise<void> {
    const wanted = [...new Set(ids.map(Number))]
    const current = await client.clientModpack.findMany({ where })
    const otherKey = 'client_id' in where ? 'modpack_id' : 'client_id'
    const remove = current.filter((pivot) => !wanted.includes(pivot[otherKey])).map((pivot) => pivot.id)
    if (remove.length > 0) {
        await client.clientModpack.deleteMany({ where: { id: { in: remove } } })
    }
    const currentIds = new Set(current.map((pivot) => pivot[otherKey]))
    const add = wanted.filter((id) => !currentIds.has(id))
    if (add.length > 0) {
        await client.clientModpack.createMany({ data: add.map((id) => ({ ...where, [otherKey]: id }) as { client_id: number; modpack_id: number }) })
    }
}
