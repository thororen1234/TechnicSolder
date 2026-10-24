import { versionCompare } from '../../support/version-compare.js'
import { ImportedModData, type SearchResult } from '../imported-mod-data.js'
import { ModProvider } from '../mod-provider.js'
import { mavenVersions } from './forge.js'

/**
 * NeoForge, packaged for Technic with its installer as bin/modpack.jar.
 * Minecraft 1.20.1 builds were published as net.neoforged:forge ("1.20.1-47.1.106"); later builds as
 * net.neoforged:neoforge, versioned after Minecraft: "21.1.263" is 1.21.1 and "26.3.0.95" is 26.3.
 */
export class NeoForge extends ModProvider {
    static override key = 'neoforge'

    static override displayName(): string {
        return 'NeoForge'
    }

    protected static override apiUrl(): string {
        return 'https://maven.neoforged.net/releases/net/neoforged'
    }

    protected static override zipFolder(): string {
        return 'bin'
    }

    protected static override useRawVersion(): boolean {
        return true
    }

    private static async fetchMavenVersions(artifact: string): Promise<string[]> {
        return mavenVersions(await this.requestText(`/${artifact}/maven-metadata.xml`))
    }

    /** Map a NeoForge version to the Minecraft version it targets */
    static minecraftVersion(version: string): string | null {
        // Legacy net.neoforged:forge builds carry the Minecraft version as a prefix
        const legacy = /^(1\.\d+(?:\.\d+)?)-/.exec(version)
        if (legacy) {
            return legacy[1]
        }
        const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
        if (!match) {
            return null
        }
        const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])]
        // Year-based Minecraft versions (26.1 and later): "{year}.{drop}.{hotfix}.{build}"
        if (major >= 25) {
            return patch > 0 ? `${major}.${minor}.${patch}` : `${major}.${minor}`
        }
        // "{minor}.{patch}.{build}" for Minecraft 1.{minor}.{patch}
        return minor > 0 ? `1.${major}.${minor}` : `1.${major}`
    }

    /** All builds grouped by Minecraft version, newest Minecraft version first, builds newest first */
    private static async getVersionsMap(): Promise<Map<string, string[]>> {
        const legacy = (await this.fetchMavenVersions('forge')).filter((version) => /^1\.\d+(?:\.\d+)?-\d/.test(version))
        const grouped = new Map<string, string[]>()
        for (const version of [...legacy, ...(await this.fetchMavenVersions('neoforge'))]) {
            const minecraft = this.minecraftVersion(version)
            if (minecraft !== null) {
                grouped.set(minecraft, [...(grouped.get(minecraft) ?? []), version])
            }
        }
        return new Map(
            [...grouped.entries()].sort(([a], [b]) => versionCompare(b, a)).map(([minecraft, versions]) => [minecraft, [...versions].reverse()]),
        )
    }

    static override async search(query: string, _page = 1, gameVersion = ''): Promise<SearchResult> {
        const mods: ImportedModData[] = []
        for (const [minecraft, versions] of await this.getVersionsMap()) {
            if (
                (query !== '' && minecraft !== query && !minecraft.startsWith(`${query}.`)) ||
                (gameVersion !== '' && !minecraft.toLowerCase().includes(gameVersion.toLowerCase()))
            ) {
                continue
            }
            mods.push(this.generateModData(minecraft, versions))
        }
        return { mods, pagination: { currentPage: 1, totalPages: 1, totalItems: mods.length } }
    }

    /** @param modId Minecraft version */
    static override async mod(modId: string): Promise<ImportedModData | null> {
        const versions = (await this.getVersionsMap()).get(modId)
        return versions === undefined ? null : this.generateModData(modId, versions)
    }

    private static generateModData(minecraft: string, versions: string[]): ImportedModData {
        const modData = new ImportedModData()
        modData.id = minecraft
        modData.slug = 'neoforge'
        modData.name = 'NeoForge'
        modData.summary = 'NeoForge is the modern continuation of the Minecraft Forge modding ecosystem.'
        modData.displayName = `NeoForge ${minecraft}`
        modData.displaySummary = `NeoForge builds for Minecraft ${minecraft}`
        modData.authors = 'NeoForged'
        modData.thumbnailUrl = 'https://neoforged.net/img/authors/neoforged.png'
        modData.thumbnailDesc = 'NeoForge'
        modData.websiteUrl = 'https://neoforged.net/'
        for (const version of versions) {
            const artifact = version.startsWith('1.') ? 'forge' : 'neoforge'
            modData.versions.set(`${artifact}-${version}`, {
                url: `${this.apiUrl()}/${artifact}/${version}/${artifact}-${version}-installer.jar`,
                filename: 'modpack.jar',
                label: version,
                gameVersions: [minecraft],
                versionType: /-(beta|alpha)/i.test(version) ? 'beta' : 'release',
            })
        }
        return modData
    }
}
