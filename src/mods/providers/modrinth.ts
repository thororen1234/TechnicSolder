import { ImportedModData, type SearchResult } from '../imported-mod-data.js'
import { ModProvider, type Json } from '../mod-provider.js'

function chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = []
    for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size))
    }
    return chunks
}

export class Modrinth extends ModProvider {
    static override key = 'modrinth'

    static override displayName(): string {
        return 'Modrinth'
    }

    protected static override apiUrl(): string {
        return 'https://api.modrinth.com/v2'
    }

    static override async search(query: string, page = 1, gameVersion = '', loader = ''): Promise<SearchResult> {
        const pageSize = 20
        page = Math.max(1, page)
        const facets: string[][] = [['project_type:mod']]
        if (gameVersion !== '') {
            facets.push([`versions:${gameVersion}`])
        }
        if (loader !== '') {
            facets.push([`categories:${loader}`])
        }
        const params = new URLSearchParams({
            limit: String(pageSize),
            offset: String((page - 1) * pageSize),
            query,
            index: 'relevance',
            facets: JSON.stringify(facets),
        })
        const data = await this.request(`/search?${params}`)
        const result: SearchResult = {
            mods: [],
            pagination: {
                currentPage: page,
                totalPages: data?.total_hits !== undefined ? Math.max(1, Math.ceil(data.total_hits / pageSize)) : 1,
                totalItems: data?.total_hits ?? 0,
            },
        }
        if (data === null) {
            result.errors = { api_error: 'Modrinth could not be reached. Try again in a moment.' }
            return result
        }
        for (const mod of data.hits ?? []) {
            result.mods.push(this.generateModData(mod))
        }
        return result
    }

    static override async mod(modId: string): Promise<ImportedModData | null> {
        return this.modFor(modId)
    }

    static override async modFor(modId: string, gameVersion = '', loader = ''): Promise<ImportedModData | null> {
        const mod = await this.request(`/project/${encodeURIComponent(modId)}`)
        if (mod === null || typeof mod !== 'object' || Array.isArray(mod)) {
            return null
        }
        const modData = this.generateModData(mod)
        // Project responses carry no author; take the team owner instead
        const members: Json[] = (await this.request(`/project/${encodeURIComponent(modId)}/members`)) ?? []
        const owner = members.find((member) => member?.role === 'Owner') ?? members[0] ?? null
        if (owner?.user?.username !== undefined && owner.user.username !== null) {
            modData.authors = owner.user.username
        }
        const filters = new URLSearchParams()
        if (gameVersion !== '') {
            filters.set('game_versions', JSON.stringify([gameVersion]))
        }
        if (loader !== '') {
            filters.set('loaders', JSON.stringify([loader]))
        }
        const query = filters.size > 0 ? `?${filters}` : ''
        for (const version of (await this.request(`/project/${encodeURIComponent(modId)}/version${query}`)) ?? []) {
            this.addVersion(modData, version)
        }
        return modData
    }

    /**
     * Load specific versions in bulk, grouped by project. Used by pack imports.
     *
     * @returns Keyed by project ID, each holding only the requested versions
     */
    static async modsForVersions(versionIds: string[]): Promise<Map<string, ImportedModData>> {
        const versions: Json[] = []
        for (const ids of chunk([...new Set(versionIds)], 100)) {
            for (const version of (await this.request(`/versions?${new URLSearchParams({ ids: JSON.stringify(ids) })}`)) ?? []) {
                versions.push(version)
            }
        }
        const projectIds = [...new Set(versions.map((version) => version.project_id))]
        const mods = new Map<string, ImportedModData>()
        for (const ids of chunk(projectIds, 100)) {
            for (const project of (await this.request(`/projects?${new URLSearchParams({ ids: JSON.stringify(ids) })}`)) ?? []) {
                mods.set(project.id, this.generateModData(project))
            }
        }
        for (const version of versions) {
            const modData = mods.get(version.project_id)
            if (modData) {
                this.addVersion(modData, version)
            }
        }
        return mods
    }

    /**
     * Find the Modrinth files matching the given SHA-1 hashes.
     *
     * @returns Keyed by SHA-1
     */
    static async filesByHash(sha1Hashes: string[]): Promise<Map<string, { url: string; sha1: string; sha512: string }>> {
        const found = new Map<string, { url: string; sha1: string; sha512: string }>()
        for (const hashes of chunk([...new Set(sha1Hashes)], 500)) {
            const versions = (await this.post('/version_files', { hashes, algorithm: 'sha1' })) ?? {}
            for (const [hash, version] of Object.entries<Json>(versions)) {
                for (const file of version?.files ?? []) {
                    if (file?.hashes?.sha1 === hash && file.url) {
                        found.set(hash, { url: file.url, sha1: file.hashes.sha1, sha512: file.hashes.sha512 ?? '' })
                    }
                }
            }
        }
        return found
    }

    private static addVersion(modData: ImportedModData, version: Json): void {
        const files: Json[] = version.files ?? []
        const primaryFile = files.find((file) => file?.primary === true) ?? files[0] ?? null
        if (!primaryFile || !primaryFile.url) {
            return
        }
        modData.versions.set(String(version.id), {
            url: primaryFile.url,
            filename: primaryFile.filename ?? 'mod.jar',
            label: version.version_number ?? version.id,
            gameVersions: version.game_versions ?? [],
            loaders: version.loaders ?? [],
            versionType: version.version_type ?? 'release',
            sha1: primaryFile.hashes?.sha1 ?? null,
            dependencies: [
                ...new Set<string>(
                    (version.dependencies ?? [])
                        .filter((dependency: Json) => (dependency?.dependency_type ?? '') === 'required' && dependency.project_id)
                        .map((dependency: Json) => dependency.project_id),
                ),
            ],
        })
    }

    private static generateModData(mod: Json): ImportedModData {
        const modData = new ImportedModData()
        modData.id = mod.project_id ?? mod.id ?? null
        modData.slug = mod.slug ?? (modData.id === null ? null : String(modData.id))
        modData.name = mod.title ?? mod.name ?? 'Unknown Mod'
        modData.summary = mod.description ?? ''
        modData.authors = mod.author ?? 'Unknown'
        modData.thumbnailUrl = mod.icon_url ?? null
        modData.thumbnailDesc = modData.name
        modData.websiteUrl = `https://modrinth.com/${mod.project_type ?? 'mod'}/${modData.slug}`
        modData.environment = mod.server_side === 'unsupported' ? 'client' : mod.client_side === 'unsupported' ? 'server' : null
        return modData
    }
}
