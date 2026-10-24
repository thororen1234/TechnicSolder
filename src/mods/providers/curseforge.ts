import { config } from '../../config.js'
import { ImportedModData, type SearchResult } from '../imported-mod-data.js'
import { ModProvider, type Json } from '../mod-provider.js'

/** CurseForge game ID for Minecraft */
const GAME_ID = 432
/** CurseForge class ID for mods */
const CLASS_MODS = 6
/** Folders for non-mod project classes (resource packs, shader packs) */
const CLASS_FOLDERS: Record<number, string> = {
    12: 'resourcepacks',
    6552: 'shaderpacks',
}
const LOADER_TYPES: Record<string, number> = {
    forge: 1,
    fabric: 4,
    quilt: 5,
    neoforge: 6,
}

function chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = []
    for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size))
    }
    return chunks
}

export class CurseForge extends ModProvider {
    static override key = 'curseforge'

    static override displayName(): string {
        return 'CurseForge'
    }

    protected static override apiUrl(): string {
        return 'https://api.curseforge.com/v1'
    }

    protected static override apiHeaders(): Record<string, string> {
        return { ...this.downloadHeaders(), 'x-api-key': String(config.solder.curseforge_api_key) }
    }

    static hasApiKey(): boolean {
        return Boolean(config.solder.curseforge_api_key)
    }

    static override async search(query: string, page = 1, gameVersion = '', loader = ''): Promise<SearchResult> {
        const pageSize = 20
        page = Math.max(1, page)
        const result: SearchResult = { mods: [], pagination: { currentPage: page, totalPages: 1, totalItems: 0 } }
        if (!this.hasApiKey()) {
            result.errors = { no_api_key: 'CurseForge API key is not configured. Set CURSEFORGE_API_KEY in your .env file.' }
            return result
        }
        const params = new URLSearchParams({
            gameId: String(GAME_ID),
            classId: String(CLASS_MODS),
            searchFilter: query,
            pageSize: String(pageSize),
            index: String((page - 1) * pageSize),
            sortField: '2', // popularity
            sortOrder: 'desc',
        })
        if (gameVersion !== '') {
            params.set('gameVersion', gameVersion)
        }
        if (LOADER_TYPES[loader] !== undefined) {
            params.set('modLoaderType', String(LOADER_TYPES[loader]))
        }
        const data = await this.request(`/mods/search?${params}`)
        if (data?.data === undefined || data.data === null) {
            result.errors = { api_error: 'CurseForge API request failed. Check your API key.' }
            return result
        }
        for (const mod of data.data) {
            result.mods.push(this.generateModData(mod))
        }
        // CurseForge refuses to page past 10,000 results
        const total = Math.min(data.pagination?.totalCount ?? 0, 10000)
        result.pagination.totalItems = data.pagination?.totalCount ?? 0
        result.pagination.totalPages = Math.max(1, Math.ceil(total / pageSize))
        return result
    }

    static override async mod(modId: string): Promise<ImportedModData | null> {
        return this.modFor(modId)
    }

    /** CurseForge pages files 50 at a time, newest first, so filter server-side when a game version or loader is known */
    static override async modFor(modId: string, gameVersion = '', loader = ''): Promise<ImportedModData | null> {
        if (!this.hasApiKey()) {
            return null
        }
        const mod = (await this.request(`/mods/${encodeURIComponent(modId)}`))?.data ?? null
        if (mod === null || typeof mod !== 'object') {
            return null
        }
        const modData = this.generateModData(mod)
        const params = new URLSearchParams({ pageSize: '50' })
        if (gameVersion !== '') {
            params.set('gameVersion', gameVersion)
        }
        if (LOADER_TYPES[loader] !== undefined) {
            params.set('modLoaderType', String(LOADER_TYPES[loader]))
        }
        const files = (await this.request(`/mods/${encodeURIComponent(modId)}/files?${params}`))?.data ?? mod.latestFiles ?? []
        for (const file of files) {
            this.addFile(modData, file, CLASS_FOLDERS[mod.classId ?? 0] ?? null)
        }
        return modData
    }

    /**
     * Load specific files in bulk, grouped by project. Used by pack imports.
     *
     * @returns Keyed by project ID, each holding only the requested files
     */
    static async modsForFiles(fileIds: (number | string)[]): Promise<Map<string, ImportedModData>> {
        const mods = new Map<string, ImportedModData>()
        if (!this.hasApiKey() || fileIds.length === 0) {
            return mods
        }
        const files: Json[] = []
        for (const ids of chunk([...new Set(fileIds.map((id) => Number.parseInt(String(id), 10)))], 500)) {
            files.push(...((await this.post('/mods/files', { fileIds: ids }))?.data ?? []))
        }
        const modIds = [...new Set(files.map((file) => Number.parseInt(String(file.modId), 10)))]
        const classes = new Map<string, number>()
        for (const ids of chunk(modIds, 500)) {
            for (const mod of (await this.post('/mods', { modIds: ids }))?.data ?? []) {
                mods.set(String(mod.id), this.generateModData(mod))
                classes.set(String(mod.id), mod.classId ?? CLASS_MODS)
            }
        }
        for (const file of files) {
            const modData = mods.get(String(file.modId))
            if (modData) {
                this.addFile(modData, file, CLASS_FOLDERS[classes.get(String(file.modId)) ?? CLASS_MODS] ?? null)
            }
        }
        return mods
    }

    private static addFile(modData: ImportedModData, file: Json, folder: string | null): void {
        const gameVersions: string[] = []
        const loaders: string[] = []
        const sides: string[] = []
        for (const tag of file.gameVersions ?? []) {
            const lower = String(tag).toLowerCase()
            if (/^\d+\.\d+/.test(tag)) {
                gameVersions.push(tag)
            } else if (LOADER_TYPES[lower] !== undefined) {
                loaders.push(lower)
            } else if (lower === 'client' || lower === 'server') {
                sides.push(lower)
            }
        }
        const sha1 = (file.hashes ?? []).find((hash: Json) => hash?.algo === 1)?.value ?? null
        modData.versions.set(String(file.id), {
            // downloadUrl is null when the author disabled third-party distribution
            url: file.downloadUrl ?? null,
            filename: file.fileName ?? 'mod.jar',
            label: file.displayName ?? file.fileName ?? String(file.id),
            gameVersions,
            loaders,
            versionType: file.releaseType === 2 ? 'beta' : file.releaseType === 3 ? 'alpha' : 'release',
            folder,
            sha1,
            // Files tagged for only one side ("Client" or "Server")
            environment: sides.length === 1 ? sides[0] : null,
            // relationType 3 = required dependency
            dependencies: [
                ...new Set<string>((file.dependencies ?? []).filter((dependency: Json) => (dependency?.relationType ?? 0) === 3).map((dependency: Json) => String(dependency.modId))),
            ],
        })
    }

    private static generateModData(mod: Json): ImportedModData {
        const modData = new ImportedModData()
        modData.id = mod.id ?? null
        modData.slug = mod.slug ?? null
        modData.name = mod.name ?? 'Unknown Mod'
        modData.summary = mod.summary ?? ''
        modData.authors = mod.authors?.[0]?.name ?? 'Unknown'
        modData.thumbnailUrl = mod.logo?.thumbnailUrl ?? mod.logo?.url ?? null
        modData.thumbnailDesc = modData.name
        modData.websiteUrl = mod.links?.websiteUrl ?? null
        return modData
    }
}
