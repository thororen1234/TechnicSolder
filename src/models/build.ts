import { escapeRegExp } from '../support/str.js'
import type { ApiAuthContext } from './api-auth.js'
import { isModpackAccessibleBy } from './modpack.js'
import type { Build, Modpack, ModversionWithMod } from './types.js'

export const NOT_FOUND_CACHE_VALUE = 'not_found'

export type LoaderType = 'forge' | 'neoforge' | 'fabric' | 'quilt'

export interface Loader {
    type: LoaderType
    version: string
}

export function isBuildAccessibleBy(build: Build, modpack: Modpack | null | undefined, auth: ApiAuthContext): boolean {
    if (!modpack || !build.is_published) {
        return false
    }
    return (!modpack.private && !build.private) || isModpackAccessibleBy(modpack, auth)
}

export function isLive(build: Pick<Build, 'is_published' | 'private'>): boolean {
    return build.is_published && !build.private
}

/**
 * The mod loader a build uses, from its loader mod (as created by the loader importers) or the loader recorded
 * by a modpack import.
 */
export function buildLoader(build: Pick<Build, 'minecraft' | 'forge'>, modversions: ModversionWithMod[]): Loader | null {
    const minecraft = String(build.minecraft ?? '')
    const withoutMinecraft = (version: string) => (version.startsWith(`${minecraft}-`) ? version.slice(minecraft.length + 1) : version)

    for (const modversion of modversions) {
        let version = String(modversion.version)
        switch (modversion.mod?.name ?? '') {
            case 'fabric-loader':
                return { type: 'fabric', version: withoutMinecraft(version) }
            case 'quilt-loader':
                return { type: 'quilt', version: withoutMinecraft(version) }
            case 'forge': {
                // Imported as "{mc}-forge-{version}"; very old builds also end in "-{mc}"
                const match = /-forge-(.+)$/.exec(version)
                version = match ? match[1] : withoutMinecraft(version)
                return { type: 'forge', version: version.replace(new RegExp(`-${escapeRegExp(minecraft)}$`), '') }
            }
            case 'neoforge':
                // Imported as "neoforge-{version}" or, for 1.20.1, "forge-{mc}-{version}"
                version = version.replace(/^(neoforge|forge)-/, '')
                return { type: 'neoforge', version: withoutMinecraft(version) }
        }
    }

    const match = /^(neoforge|forge|fabric|quilt)(?:-loader)?-(.+)$/.exec(String(build.forge ?? ''))
    if (match) {
        return { type: match[1] as LoaderType, version: match[2] }
    }
    return null
}

/** Build columns copied when cloning or exporting a build */
export const BUILD_COPY_FIELDS = ['version', 'minecraft', 'forge', 'is_published', 'private', 'min_java', 'java_runtime', 'min_memory'] as const
