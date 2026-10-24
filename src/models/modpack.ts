import type { ApiAuthContext } from './api-auth.js'
import { isBuildAccessibleBy } from './build.js'
import { canAccessModpack } from './permissions.js'
import type { Build, Modpack } from './types.js'

export function isModpackAccessibleBy(modpack: Pick<Modpack, 'id'>, auth: ApiAuthContext): boolean {
    return (
        auth.key !== null ||
        (auth.user !== null && canAccessModpack(auth.user.permission, modpack.id)) ||
        (auth.client !== null && auth.client.modpackIds.includes(modpack.id))
    )
}

/** A modpack as the launcher API returns it */
export function modpackApiResponse(modpack: Modpack, builds: Build[], auth: ApiAuthContext): Record<string, unknown> {
    return {
        id: modpack.id,
        name: modpack.slug,
        display_name: modpack.name,
        url: modpack.url,
        icon: modpack.icon_url,
        icon_md5: modpack.icon_md5,
        logo: modpack.logo_url,
        logo_md5: modpack.logo_md5,
        background: modpack.background_url,
        background_md5: modpack.background_md5,
        recommended: modpack.recommended,
        latest: modpack.latest,
        builds: builds
            .filter((build) => isBuildAccessibleBy(build, modpack, auth))
            .sort((a, b) => a.id - b.id)
            .map((build) => build.version),
    }
}

/** Whether any build of the modpack is private */
export function hasPrivateBuilds(builds: Build[]): boolean {
    return builds.some((build) => build.private)
}
