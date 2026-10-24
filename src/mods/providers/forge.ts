import { versionCompare } from '../../support/version-compare.js'
import { ImportedModData, type SearchResult } from '../imported-mod-data.js'
import { ModProvider } from '../mod-provider.js'

/** The <version> entries of a maven-metadata.xml */
export function mavenVersions(xml: string | null): string[] {
    if (!xml) {
        return []
    }
    const versions = /<versions>([\s\S]*?)<\/versions>/.exec(xml)
    if (!versions) {
        return []
    }
    return [...versions[1].matchAll(/<version>\s*([^<]*?)\s*<\/version>/g)].map((match) => match[1])
}

/**
 * Minecraft Forge, packaged for Technic as bin/modpack.jar.
 * Technic needs the universal jar for Minecraft 1.12.2 and older, and the installer jar for 1.13 and newer.
 */
export class Forge extends ModProvider {
    static override key = 'forge'

    static override displayName(): string {
        return 'Forge'
    }

    protected static override apiUrl(): string {
        return 'https://maven.minecraftforge.net/net/minecraftforge/forge'
    }

    protected static override zipFolder(): string {
        return 'bin'
    }

    protected static override useRawVersion(): boolean {
        return true
    }

    /** Forge builds grouped by Minecraft version, newest Minecraft version first, builds oldest first */
    private static async getVersionsMap(): Promise<Map<string, string[]>> {
        const grouped = new Map<string, string[]>()
        for (const raw of mavenVersions(await this.requestText('/maven-metadata.xml'))) {
            const dash = raw.indexOf('-')
            const minecraft = dash === -1 ? '' : raw.slice(0, dash)
            const forgeVersion = dash === -1 ? '' : raw.slice(dash + 1)
            if (minecraft === '' || forgeVersion === '') {
                continue
            }
            grouped.set(minecraft, [...(grouped.get(minecraft) ?? []), forgeVersion])
        }
        return new Map([...grouped.entries()].sort(([a], [b]) => versionCompare(b, a)))
    }

    static override async search(query: string, _page = 1, gameVersion = ''): Promise<SearchResult> {
        const mods: ImportedModData[] = []
        for (const [minecraft, versions] of await this.getVersionsMap()) {
            if (
                (query !== '' && !minecraft.toLowerCase().includes(query.toLowerCase())) ||
                (gameVersion !== '' && !minecraft.toLowerCase().includes(gameVersion.toLowerCase()))
            ) {
                continue
            }
            mods.push(this.generateModData(minecraft, [...versions].reverse()))
        }
        return { mods, pagination: { currentPage: 1, totalPages: 1, totalItems: mods.length } }
    }

    /** @param modId Minecraft version */
    static override async mod(modId: string): Promise<ImportedModData | null> {
        const versions = (await this.getVersionsMap()).get(modId)
        return versions === undefined ? null : this.generateModData(modId, [...versions].reverse())
    }

    /** Whether Technic needs the universal jar (Minecraft 1.12.2 and older) rather than the installer */
    static usesUniversalJar(minecraft: string): boolean {
        return minecraft.startsWith('1.') && versionCompare(minecraft, '1.13', '<')
    }

    private static generateModData(minecraft: string, versions: string[]): ImportedModData {
        const modData = new ImportedModData()
        modData.id = minecraft
        modData.slug = 'forge'
        modData.name = 'Minecraft Forge'
        modData.summary = 'Forge mod loader'
        modData.displayName = `Minecraft Forge ${minecraft}`
        modData.displaySummary = `Forge for Minecraft ${minecraft}`
        modData.authors = 'MinecraftForge'
        modData.thumbnailUrl = 'https://files.minecraftforge.net/static/images/logo.svg'
        modData.thumbnailDesc = 'Forge'
        modData.websiteUrl = 'https://files.minecraftforge.net/'
        const classifier = this.usesUniversalJar(minecraft) ? 'universal' : 'installer'
        for (const version of versions) {
            modData.versions.set(`${minecraft}-forge-${version}`, {
                url: `${this.apiUrl()}/${minecraft}-${version}/forge-${minecraft}-${version}-${classifier}.jar`,
                filename: 'modpack.jar',
                label: version,
                gameVersions: [minecraft],
                versionType: 'release',
            })
        }
        return modData
    }
}
