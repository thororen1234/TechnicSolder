/**
 * One importable version of a mod (or mod loader), keyed by a provider-specific version key.
 */
export interface VersionData {
    /** Download URL of the file; null when the author disabled third-party downloads */
    url: string | null
    /** File name to store inside the Solder zip */
    filename: string
    /** Human readable version name (falls back to the key) */
    label?: string
    /** Minecraft versions the file supports */
    gameVersions?: string[]
    /** Mod loaders the file supports (lowercase) */
    loaders?: string[]
    /** "release", "beta" or "alpha" */
    versionType?: string
    /** Folder inside the Solder zip, overriding the provider default */
    folder?: string | null
    /** Checksum to verify the download against */
    sha1?: string | null
    /** "client" or "server" when the file only belongs on one side */
    environment?: string | null
    /** Provider project IDs of required mods */
    dependencies?: string[]
    /** Not actually from the provider, so not recorded as its file */
    untracked?: boolean
}

/**
 * A mod (or mod loader) as returned by a ModProvider, with its importable versions.
 */
export class ImportedModData {
    id: string | number | null = null
    slug: string | null = null
    name = ''
    summary = ''
    authors: string | null = null
    thumbnailUrl: string | null = null
    thumbnailDesc: string | null = null
    websiteUrl: string | null = null
    /** Name shown in search results instead of name, e.g. "Fabric Loader 1.20.1" */
    displayName: string | null = null
    /** Summary shown in search results instead of summary */
    displaySummary: string | null = null
    /** "client" or "server" when the whole project only runs on one side (a version's own environment wins) */
    environment: string | null = null
    /** Versions in the provider's order (newest first); a Map because keys may be numeric */
    versions = new Map<string, VersionData>()

    /** Plain data for caching; restore with ImportedModData.fromJSON */
    toJSON(): object {
        return { ...this, versions: [...this.versions.entries()] }
    }

    static fromJSON(data: Record<string, unknown> | null): ImportedModData | null {
        if (data === null) {
            return null
        }
        const modData = Object.assign(new ImportedModData(), data)
        modData.versions = new Map(data.versions as [string, VersionData][])
        return modData
    }
}

export interface SearchResult {
    mods: ImportedModData[]
    pagination: { currentPage: number; totalPages: number; totalItems: number }
    errors?: Record<string, string>
}

export interface InstallResult {
    success: boolean
    /** ID of the Solder mod */
    id: number
    errors: string[]
    /** Version key => modversion ID */
    modversionIds: Map<string, number>
    created: number
    existing: number
    /** Names of required mods also imported */
    dependencies: string[]
}
