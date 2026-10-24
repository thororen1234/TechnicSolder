import { db } from '../database/prisma.js'
import { buildLoader } from '../models/build.js'
import { buildsForModpacks, modversionsForBuild, syncBuildModversions } from '../models/relations.js'
import type { Build, ModversionWithMod } from '../models/types.js'
import { ImportedModData } from '../mods/imported-mod-data.js'
import { latestStableVersionForGame, type ProviderClass } from '../mods/mod-provider.js'
import { provider as providerByKey } from '../mods/mod-providers.js'
import { Cache } from '../support/cache.js'
import { toIso8601String } from '../support/dates.js'
import { logger } from '../support/logger.js'
import type { Progress } from './task-tracker.js'

/**
 * Finds newer versions of a build's mods on the providers they were imported from, and creates new builds with
 * those updates applied.
 */
export interface ModUpdate {
    modversion_id: number
    mod: string
    name: string
    current: string
    latest_key: string
    latest_label: string
    provider: string
}

export interface UpdateSummary {
    checked_at: string
    builds: { modpack_id: number; modpack: string; build_id: number; build: string; count: number; mods: string[] }[]
}

export interface BuildCopyResult {
    build: Build
    updated: number
    errors: string[]
}

const LOADER_PROVIDERS = ['fabric', 'quilt', 'forge', 'neoforge']
const CACHE_SECONDS = 1800

/** Where the latest results of checkAllModpacks() are kept for the dashboard */
export const SUMMARY_CACHE_KEY = 'solder-update-summary'

/** Copy a build's columns to a new build ($build->replicate()) */
async function replicateBuild(build: Build, changes: Partial<Build>): Promise<Build> {
    const { id: _id, created_at: _created, updated_at: _updated, ...attributes } = build
    return db.build.create({ data: { ...attributes, ...changes } })
}

export class BuildUpdateService {
    constructor(private readonly progress: Progress | null = null) {}

    /** Check the latest build of every modpack (the one marked Latest, or else the newest) and remember the results */
    async checkAllModpacks(): Promise<UpdateSummary> {
        const modpacks = await db.modpack.findMany({ orderBy: { name: 'asc' } })
        const buildsByModpack = await buildsForModpacks(modpacks.map((modpack) => modpack.id))
        const builds: UpdateSummary['builds'] = []
        for (const [index, modpack] of modpacks.entries()) {
            const modpackBuilds = buildsByModpack.get(modpack.id) ?? []
            const build = modpackBuilds.find((candidate) => candidate.version === modpack.latest) ?? [...modpackBuilds].sort((a, b) => b.id - a.id)[0]
            if (build === undefined) {
                continue
            }
            await this.report(index, modpacks.length, `Checking ${modpack.name} ${build.version}`)
            let updates: ModUpdate[]
            try {
                updates = await this.check(build)
            } catch (error) {
                logger.report(error)
                continue
            }
            if (updates.length > 0) {
                builds.push({
                    modpack_id: modpack.id,
                    modpack: modpack.name,
                    build_id: build.id,
                    build: build.version,
                    count: updates.length,
                    mods: updates.map((update) => update.name),
                })
            }
        }
        const summary: UpdateSummary = { checked_at: toIso8601String(), builds }
        await Cache.forever(SUMMARY_CACHE_KEY, summary)
        return summary
    }

    /** Mods in the build with a newer version available. Mods added by hand (with no provider) are skipped. */
    async check(build: Build, modversions?: ModversionWithMod[]): Promise<ModUpdate[]> {
        modversions ??= await modversionsForBuild(build.id)
        const tracked = modversions.filter((modversion) => this.providerFor(modversion) !== null)
        const updates: ModUpdate[] = []
        for (const [index, modversion] of tracked.entries()) {
            await this.report(index, tracked.length, `Checking ${modversion.mod.pretty_name}`)
            const modData = await this.lookup(build, modversions, modversion)
            if (modData === null) {
                continue
            }
            const latest = this.latestFor(build, modversions, modversion, modData)
            if (latest === null) {
                continue
            }
            updates.push({
                modversion_id: modversion.id,
                mod: modversion.mod.name,
                name: modversion.mod.pretty_name || modversion.mod.name,
                current: modversion.version,
                latest_key: latest,
                latest_label: modData.versions.get(latest)?.label ?? latest,
                provider: this.providerFor(modversion)!.displayName(),
            })
        }
        return updates
    }

    /**
     * Copy the build under a new version and swap in the latest versions of the given mod versions.
     *
     * @param modversionIds Mod versions to update; others are copied unchanged
     */
    async apply(build: Build, newVersion: string, modversionIds: number[]): Promise<BuildCopyResult> {
        const modversions = await modversionsForBuild(build.id)
        const newBuild = await replicateBuild(build, { version: newVersion, is_published: false })
        const ids = modversions.map((modversion) => modversion.id)
        const chosen = modversions.filter((modversion) => modversionIds.includes(modversion.id))
        let updated = 0
        const errors: string[] = []
        for (const [index, modversion] of chosen.entries()) {
            await this.report(index, chosen.length, `Updating ${modversion.mod.pretty_name}`)
            const provider = this.providerFor(modversion)
            const modData = provider ? await this.lookup(build, modversions, modversion) : null
            const latest = modData ? this.latestFor(build, modversions, modversion, modData) : null
            if (latest === null || provider === null) {
                continue
            }
            const result = await provider.install(String(modversion.provider_project_id), [latest], modData)
            const installed = result.modversionIds.get(latest)
            if (installed !== undefined) {
                ids[ids.indexOf(modversion.id)] = installed
                updated++
            } else {
                errors.push(...(result.errors.length > 0 ? result.errors : [`${modversion.mod.pretty_name}: update failed`]))
            }
        }
        await syncBuildModversions(newBuild.id, [...new Set(ids)])
        return { build: newBuild, updated, errors }
    }

    /**
     * Copy the build to another Minecraft version: the loader and every mod imported from a provider are swapped
     * for their newest version for that Minecraft version. Mods added by hand are copied unchanged, and mods
     * without a compatible version are left out.
     */
    async copyToMinecraft(build: Build, newVersion: string, minecraft: string): Promise<BuildCopyResult> {
        const modversions = await modversionsForBuild(build.id)
        const newBuild = await replicateBuild(build, { version: newVersion, minecraft, forge: null, is_published: false })
        const loaders = this.compatibleLoaders(build, modversions)
        const ids: number[] = []
        let updated = 0
        const errors: string[] = []
        for (const [index, modversion] of modversions.entries()) {
            const name = modversion.mod.pretty_name || modversion.mod.name
            await this.report(index, modversions.length, `Finding ${name} for Minecraft ${minecraft}`)
            const provider = this.providerFor(modversion)
            if (provider === null) {
                ids.push(modversion.id)
                errors.push(`${name} ${modversion.version} was added by hand, so it was copied unchanged. Check that it works on Minecraft ${minecraft}.`)
                continue
            }
            const isLoader = this.isLoader(modversion)
            const projectId = isLoader ? minecraft : String(modversion.provider_project_id)
            const modData = await provider.modFor(projectId, isLoader ? '' : minecraft, isLoader ? '' : (loaders[0] ?? ''))
            const latest = modData ? latestStableVersionForGame(modData.versions, isLoader ? '' : minecraft, '', isLoader ? [] : loaders) : null
            if (latest === null) {
                errors.push(`${name} has no version for Minecraft ${minecraft}, so it was left out.`)
                continue
            }
            const result = await provider.install(projectId, [latest], modData)
            const installed = result.modversionIds.get(latest)
            if (installed !== undefined) {
                ids.push(installed)
                updated++
            } else {
                errors.push(...(result.errors.length > 0 ? result.errors : [`${name} could not be imported for Minecraft ${minecraft}.`]))
            }
        }
        await syncBuildModversions(newBuild.id, [...new Set(ids)])
        return { build: newBuild, updated, errors }
    }

    private providerFor(modversion: ModversionWithMod): ProviderClass | null {
        if (!modversion.provider || !modversion.provider_project_id || !modversion.provider_version_id) {
            return null
        }
        return providerByKey(modversion.provider)
    }

    private isLoader(modversion: ModversionWithMod): boolean {
        return LOADER_PROVIDERS.includes(modversion.provider ?? '')
    }

    /** Mod loaders whose mods can run in this build. Quilt also runs Fabric mods. */
    private compatibleLoaders(build: Build, modversions: ModversionWithMod[]): string[] {
        const loader = buildLoader(build, modversions)?.type ?? null
        if (loader === null) {
            return []
        }
        return loader === 'quilt' ? ['quilt', 'fabric'] : [loader]
    }

    private async lookup(build: Build, modversions: ModversionWithMod[], modversion: ModversionWithMod): Promise<ImportedModData | null> {
        const provider = this.providerFor(modversion)!
        const isLoader = this.isLoader(modversion)
        const minecraft = isLoader ? '' : String(build.minecraft)
        const loader = isLoader ? '' : (this.compatibleLoaders(build, modversions)[0] ?? '')
        const key = `solder-updates:${modversion.provider}:${modversion.provider_project_id}:${minecraft}:${loader}`
        const cached = await Cache.remember(key, CACHE_SECONDS, async () => {
            const modData = await provider.modFor(String(modversion.provider_project_id), minecraft, loader)
            return modData === null ? null : modData.toJSON()
        })
        return ImportedModData.fromJSON(cached as Record<string, unknown> | null)
    }

    /** Key of the newest suitable version if it is newer than the one in the build, otherwise null */
    private latestFor(build: Build, modversions: ModversionWithMod[], modversion: ModversionWithMod, modData: ImportedModData): string | null {
        const isLoader = this.isLoader(modversion)
        const latest = latestStableVersionForGame(
            modData.versions,
            isLoader ? '' : String(build.minecraft),
            '',
            isLoader ? [] : this.compatibleLoaders(build, modversions),
        )
        if (latest === null || latest === modversion.provider_version_id) {
            return null
        }
        // Versions are listed newest first: never offer something older than what the build has
        const keys = [...modData.versions.keys()]
        const currentPosition = keys.indexOf(String(modversion.provider_version_id))
        const latestPosition = keys.indexOf(latest)
        return currentPosition !== -1 && latestPosition > currentPosition ? null : latest
    }

    private async report(done: number, total: number, message: string): Promise<void> {
        await this.progress?.(done, total, message)
    }
}
