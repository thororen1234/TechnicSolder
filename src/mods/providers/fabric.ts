import { ImportedModData, type SearchResult } from '../imported-mod-data.js'
import { ModProvider, type Json } from '../mod-provider.js'

/**
 * Fabric Loader, packaged for Technic as bin/version.json (the launcher profile from Fabric Meta).
 * Each Minecraft version is a search result; its versions are the loader builds for that game version.
 */
export class Fabric extends ModProvider {
    static override key = 'fabric'

    static override displayName(): string {
        return 'Fabric'
    }

    protected static override apiUrl(): string {
        return 'https://meta.fabricmc.net/v2'
    }

    protected static override zipFolder(): string {
        return 'bin'
    }

    protected static override useRawVersion(): boolean {
        return true
    }

    protected static slug(): string {
        return 'fabric-loader'
    }

    protected static authors(): string {
        return 'FabricMC'
    }

    protected static websiteUrl(): string {
        return 'https://fabricmc.net/'
    }

    protected static thumbnailUrl(): string {
        return 'https://fabricmc.net/assets/logo.png'
    }

    /** Whether a loader build is a stable release */
    protected static isStable(loader: Json): boolean {
        return Boolean(loader?.stable ?? true)
    }

    static override async search(query: string, _page = 1, gameVersion = ''): Promise<SearchResult> {
        const mods: ImportedModData[] = []
        for (const game of (await this.request('/versions/game')) ?? []) {
            const version = String(game?.version ?? '')
            if (
                !game?.stable ||
                (query !== '' && !version.toLowerCase().includes(query.toLowerCase())) ||
                (gameVersion !== '' && !version.toLowerCase().includes(gameVersion.toLowerCase()))
            ) {
                continue
            }
            mods.push(this.generateModData(version))
        }
        return { mods, pagination: { currentPage: 1, totalPages: 1, totalItems: mods.length } }
    }

    /** @param modId Minecraft version, e.g. "1.20.1" or "26.1" */
    static override async mod(modId: string): Promise<ImportedModData | null> {
        const games: Json[] = (await this.request('/versions/game')) ?? []
        if (!games.some((game) => (game?.version ?? null) === modId)) {
            return null
        }
        const modData = this.generateModData(modId)
        for (const loader of (await this.request('/versions/loader')) ?? []) {
            const loaderVersion = loader?.version ?? null
            if (!loaderVersion) {
                continue
            }
            modData.versions.set(`${modId}-${loaderVersion}`, {
                url: `${this.apiUrl()}/versions/loader/${modId}/${loaderVersion}/profile/json`,
                filename: 'version.json',
                label: loaderVersion,
                gameVersions: [modId],
                versionType: this.isStable(loader) ? 'release' : 'beta',
            })
        }
        return modData
    }

    private static generateModData(gameVersion: string): ImportedModData {
        const modData = new ImportedModData()
        modData.id = gameVersion
        modData.slug = this.slug()
        modData.name = `${this.displayName()} Loader`
        modData.summary = `${this.displayName()} Loader for Minecraft`
        modData.displayName = `${this.displayName()} Loader ${gameVersion}`
        modData.displaySummary = `${this.displayName()} Loader for Minecraft ${gameVersion}`
        modData.authors = this.authors()
        modData.thumbnailUrl = this.thumbnailUrl()
        modData.thumbnailDesc = this.authors()
        modData.websiteUrl = this.websiteUrl()
        return modData
    }
}

/** Quilt Loader, packaged like Fabric as bin/version.json from Quilt Meta */
export class Quilt extends Fabric {
    static override key = 'quilt'

    static override displayName(): string {
        return 'Quilt'
    }

    protected static override apiUrl(): string {
        return 'https://meta.quiltmc.org/v3'
    }

    protected static override slug(): string {
        return 'quilt-loader'
    }

    protected static override authors(): string {
        return 'QuiltMC'
    }

    protected static override websiteUrl(): string {
        return 'https://quiltmc.org/'
    }

    protected static override thumbnailUrl(): string {
        return 'https://quiltmc.org/assets/img/logo.svg'
    }

    /** Quilt Meta has no stable flag; pre-releases carry a "-beta"/"-pre" suffix instead */
    protected static override isStable(loader: Json): boolean {
        return !/-(beta|pre|rc|alpha)/i.test(String(loader?.version ?? ''))
    }
}
