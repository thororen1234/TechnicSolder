import { config } from '../config.js'
import { Cache, HOUR } from '../support/cache.js'
import { request } from '../support/http.js'
import { logger } from '../support/logger.js'
import { naturalCompare } from '../support/str.js'

export interface MinecraftVersion {
    version: string
    [key: string]: unknown
}

function httpOptions() {
    return { timeout: config.solder.md5_file_timeout || 15 }
}

/** Newest first, sorted naturally by version */
function sortDescending(versions: Record<string, MinecraftVersion>): MinecraftVersion[] {
    return Object.entries(versions)
        .sort(([a], [b]) => naturalCompare(b, a))
        .map(([key, value]) => ({ ...value, version: String(value?.version ?? key) }))
}

/** Release versions of Minecraft, newest first, from Technic or else Mojang */
export async function fetchMinecraftVersions(): Promise<MinecraftVersion[]> {
    try {
        const response = await request('https://www.technicpack.net/api/minecraft', httpOptions())
        if (response.status === 200) {
            return sortDescending(await response.json<Record<string, MinecraftVersion>>())
        }
    } catch (error) {
        logger.error(`Failed to fetch Minecraft versions from Technic: ${(error as Error).message}`)
    }
    // If getting them from Technic fails, get them directly from Mojang
    try {
        const response = await request('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json', httpOptions())
        if (response.status === 200) {
            const json = await response.json<{ versions: { id: string; type: string }[] }>()
            const versions: Record<string, MinecraftVersion> = {}
            for (const mojangVersion of json.versions) {
                if (mojangVersion.type === 'release') {
                    versions[mojangVersion.id] = { version: mojangVersion.id }
                }
            }
            return sortDescending(versions)
        }
    } catch (error) {
        logger.error(`Failed to fetch Minecraft versions from Mojang: ${(error as Error).message}`)
    }
    logger.error('Failed to fetch Minecraft versions')
    return []
}

export async function getMinecraftVersions(forceRefresh = false): Promise<MinecraftVersion[]> {
    if (forceRefresh) {
        await Cache.forget('minecraftversions')
    }
    const versions = await Cache.remember('minecraftversions', 3 * HOUR, async () => {
        const fetched = await fetchMinecraftVersions()
        // An empty list (both sources down) is not worth remembering
        return fetched.length > 0 ? fetched : null
    })
    return versions ?? []
}
