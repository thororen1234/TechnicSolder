import { config } from '../config.js'
import { numberFormat } from '../support/str.js'
import type { Mod, Modversion } from './types.js'

export const CLIENT_ONLY = 'client'
export const SERVER_ONLY = 'server'

/** Whether this version belongs in a client (or server) installation */
export function isNeededOn(modversion: Pick<Modversion, 'environment'>, side: string): boolean {
    return modversion.environment === null || modversion.environment === side
}

/** Relative path of the version's zip in the mod repository */
export function repositoryPath(mod: Pick<Mod, 'name'>, version: string): string {
    return `mods/${mod.name}/${mod.name}-${version}.zip`
}

/** Where the launcher downloads the version from */
export function downloadUrl(mod: Pick<Mod, 'name'>, version: string): string {
    return `${config.solder.mirror_url}${repositoryPath(mod, version)}`
}

/** A byte count as "1.50 MiB" */
export function formatFilesize(size: number): string {
    if (size >= 2 ** 30) {
        return `${numberFormat(size / 2 ** 30, 2)} GiB`
    }
    if (size >= 2 ** 20) {
        return `${numberFormat(size / 2 ** 20, 2)} MiB`
    }
    if (size >= 2 ** 10) {
        return `${numberFormat(size / 2 ** 10, 2)} KiB`
    }
    return `${numberFormat(size)} bytes`
}

export function humanFilesize(modversion: Pick<Modversion, 'filesize'>): string {
    return formatFilesize(Number(modversion.filesize ?? 0))
}

/** A mod version as the launcher API returns it */
export function toApiResponse(modversion: Modversion & { mod: Mod }, full: boolean): Record<string, unknown> {
    const response: Record<string, unknown> = {
        id: modversion.id,
        name: modversion.mod.name,
        version: modversion.version,
        md5: modversion.md5,
        filesize: modversion.filesize,
        url: downloadUrl(modversion.mod, modversion.version),
    }
    if (full) {
        Object.assign(response, {
            pretty_name: modversion.mod.pretty_name,
            author: modversion.mod.author,
            description: modversion.mod.description,
            link: modversion.mod.link,
        })
    }
    return response
}
