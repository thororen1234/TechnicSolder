import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { config, SOLDER_VERSION } from '../config.js'
import { db } from '../database/prisma.js'
import { Cache } from '../support/cache.js'
import { fileSize, hashFile, isUrl, removeFile, tempFile } from '../support/files.js'
import { ConnectionError, request, saveTo, type RequestOptions } from '../support/http.js'
import { basename, slug as toSlug } from '../support/str.js'
import { ZipReader, ZipWriter } from '../support/zip.js'
import type { Mod } from '../models/types.js'
import { ImportedModData, type InstallResult, type SearchResult, type VersionData } from './imported-mod-data.js'
import { detectVersionFromFile, environment as jarEnvironmentOf } from './jar-metadata.js'

// Provider API responses are untyped JSON
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any

export type ProviderClass = typeof ModProvider

/**
 * A source of mods (Modrinth, CurseForge) or mod loaders (Forge, NeoForge, Fabric, Quilt) that Solder can
 * search and import from. Subclasses override the static methods; `this` is the subclass, as with PHP's
 * late static binding.
 */
export abstract class ModProvider {
    /** Key of this provider, stored on imported mod versions */
    static key = ''

    static displayName(): string {
        throw new Error('Not implemented')
    }

    protected static apiUrl(): string {
        throw new Error('Not implemented')
    }

    static async search(_query: string, _page = 1, _gameVersion = '', _loader = ''): Promise<SearchResult> {
        throw new Error('Not implemented')
    }

    static async mod(_modId: string): Promise<ImportedModData | null> {
        throw new Error('Not implemented')
    }

    /**
     * Load a mod with its versions narrowed to a game version and loader, for providers that only return a page
     * of versions at a time. Defaults to mod().
     */
    static async modFor(modId: string, _gameVersion = '', _loader = ''): Promise<ImportedModData | null> {
        return this.mod(modId)
    }

    /** Headers sent to the provider API */
    protected static apiHeaders(): Record<string, string> {
        return this.downloadHeaders()
    }

    /** Headers sent when downloading files. Kept separate so API keys never reach file CDNs. */
    protected static downloadHeaders(): Record<string, string> {
        return { 'User-Agent': `TechnicPack/TechnicSolder/${SOLDER_VERSION}` }
    }

    /** Folder inside the Solder zip that downloaded files are stored in */
    protected static zipFolder(): string {
        return 'mods'
    }

    /** Whether to use the provider's version key as-is instead of reading it from the jar (mod loaders) */
    protected static useRawVersion(): boolean {
        return false
    }

    /** Import the given versions of a mod into the mod library */
    static async install(modId: string, versions: string[], modData: ImportedModData | null = null): Promise<InstallResult> {
        const response: InstallResult = {
            success: false,
            id: -1,
            errors: [],
            modversionIds: new Map(),
            created: 0,
            existing: 0,
            dependencies: [],
        }
        modData ??= await this.mod(modId)
        if (modData === null) {
            response.errors.push(`${this.displayName()} mod "${modId}" could not be loaded`)
            return response
        }
        const slug = toSlug(String(modData.slug ?? '')) || toSlug(String(modData.name ?? ''))
        if (slug === '') {
            response.errors.push(`${this.displayName()} mod "${modId}" has no usable name`)
            return response
        }
        let mod = await db.mod.findUnique({ where: { name: slug } })
        if (mod === null) {
            mod = await db.mod.create({
                data: {
                    name: slug,
                    pretty_name: modData.name || slug,
                    author: modData.authors,
                    description: modData.summary,
                    link: modData.websiteUrl,
                },
            })
            await Cache.forget('mods')
        }
        response.success = true
        response.id = mod.id
        for (const version of versions) {
            const result = await this.installVersion(mod, modData, String(version))
            if ('error' in result) {
                response.errors.push(result.error)
                continue
            }
            response.modversionIds.set(String(version), result.id)
            if (result.existing) {
                response.existing++
            } else {
                response.created++
            }
        }
        return response
    }

    /**
     * Import versions of a mod plus the mods they require, picking the newest version of each required mod for
     * the same Minecraft version and loader. Mods already imported from this provider are skipped.
     *
     * @param visited Projects already handled in this import, shared across a batch
     */
    static async installWithDependencies(
        modId: string,
        versions: string[],
        modData: ImportedModData | null = null,
        gameVersion = '',
        loader = '',
        depth = 3,
        visited: Set<string> = new Set(),
    ): Promise<InstallResult> {
        modData ??= await this.modFor(modId, gameVersion, loader)
        visited.add(String(modId))
        const result = await this.install(modId, versions, modData)
        if (depth <= 0 || modData === null) {
            return result
        }
        for (const versionKey of result.modversionIds.keys()) {
            const versionData = modData.versions.get(versionKey)
            const dependencyGame = gameVersion !== '' ? gameVersion : this.primaryGameVersion(versionData)
            const dependencyLoader = loader !== '' ? loader : String(versionData?.loaders?.[0] ?? '')
            for (const rawDependencyId of versionData?.dependencies ?? []) {
                const dependencyId = String(rawDependencyId)
                if (visited.has(dependencyId)) {
                    continue
                }
                visited.add(dependencyId)
                const alreadyImported = (await db.modversion.count({ where: { provider: this.key, provider_project_id: dependencyId } })) > 0
                if (alreadyImported) {
                    continue
                }
                const dependencyData = await this.modFor(dependencyId, dependencyGame, dependencyLoader)
                const dependencyVersion = dependencyData
                    ? latestStableVersionForGame(dependencyData.versions, dependencyGame, '', dependencyLoader)
                    : null
                if (dependencyVersion === null) {
                    result.errors.push(
                        `${modData.name} requires ${dependencyData?.name ?? dependencyId}, but no version for ` +
                            `${`${dependencyGame} ${dependencyLoader}`.trim()} was found. Add it by hand.`,
                    )
                    continue
                }
                const dependency = await this.installWithDependencies(
                    dependencyId,
                    [dependencyVersion],
                    dependencyData,
                    dependencyGame,
                    dependencyLoader,
                    depth - 1,
                    visited,
                )
                if (dependency.modversionIds.has(dependencyVersion)) {
                    result.dependencies.push(`${dependencyData!.name} ${dependencyData!.versions.get(dependencyVersion)?.label ?? dependencyVersion}`)
                }
                result.dependencies.push(...dependency.dependencies)
                result.errors.push(...dependency.errors)
            }
        }
        return result
    }

    /** Download one version and store it in the mod repository */
    protected static async installVersion(mod: Mod, modData: ImportedModData, versionKey: string): Promise<{ id: number; existing: boolean } | { error: string }> {
        const versionData = modData.versions.get(versionKey)
        const label = versionData?.label ?? versionKey
        if (versionData === undefined) {
            return { error: `${mod.pretty_name} ${label}: version not found on ${this.displayName()}` }
        }
        if (!versionData.url) {
            return { error: `${mod.pretty_name} ${label}: no download is available (the author may have disabled third-party downloads)` }
        }
        const repo = config.solder.repo_location
        if (isUrl(repo)) {
            return { error: 'The mod repository is a remote URL, so imported files cannot be saved. Set SOLDER_REPO_LOCATION to a local path.' }
        }
        const tmpFile = tempFile('solder_mod_')
        try {
            const downloadError = await this.download(versionData.url, tmpFile)
            if (downloadError !== null) {
                return { error: `${mod.pretty_name} ${label}: ${downloadError}` }
            }
            if (versionData.sha1 && (await hashFile(tmpFile, 'sha1')) !== versionData.sha1.toLowerCase()) {
                return { error: `${mod.pretty_name} ${label}: checksum mismatch, the download may be corrupt` }
            }
            let modVersion = this.useRawVersion() ? versionKey : this.resolveVersionName(tmpFile, versionData, label)
            if (modVersion === null) {
                return { error: `${mod.pretty_name} ${label}: the downloaded file is not a valid jar or zip` }
            }
            modVersion = sanitizeVersion(modVersion)
            // Remember where the file came from, for update checks and CurseForge manifests
            const source = versionData.untracked
                ? {}
                : { provider: this.key, provider_project_id: String(modData.id), provider_version_id: versionKey }
            // Client-only or server-only, from the provider or else the jar itself (loaders run on both sides)
            const environment = this.useRawVersion() ? null : (versionData.environment ?? modData.environment ?? jarEnvironment(tmpFile))

            const existing = await db.modversion.findFirst({ where: { mod_id: mod.id, version: modVersion } })
            if (existing) {
                if (existing.provider === null && Object.keys(source).length > 0) {
                    await db.modversion.update({ where: { id: existing.id }, data: source })
                }
                if (existing.environment === null && environment !== null) {
                    await db.modversion.update({ where: { id: existing.id }, data: { environment } })
                }
                return { id: existing.id, existing: true }
            }

            const finalPath = `${repo}mods/${mod.name}/${mod.name}-${modVersion}.zip`
            try {
                mkdirSync(dirname(finalPath), { recursive: true })
            } catch {
                return { error: `Could not create the folder for ${mod.name} in the mod repository` }
            }
            const folder = (versionData.folder ?? this.zipFolder()).replace(/^\/+|\/+$/g, '')
            const fileName = basename(versionData.filename ?? 'mod.jar')
            const zip = new ZipWriter()
            zip.addFile(tmpFile, (folder === '' ? '' : `${folder}/`) + fileName)
            try {
                await zip.save(finalPath)
            } catch {
                return { error: `Could not write ${finalPath}` }
            }
            const modversion = await db.modversion.create({
                data: {
                    ...source,
                    environment,
                    mod_id: mod.id,
                    version: modVersion,
                    filesize: fileSize(finalPath),
                    md5: await hashFile(finalPath),
                },
            })
            return { id: modversion.id, existing: false }
        } finally {
            removeFile(tmpFile)
        }
    }

    /** Work out the Solder version name for a downloaded file: jar metadata first, then the provider label */
    protected static resolveVersionName(file: string, versionData: VersionData, label: string): string | null {
        let detected = detectVersionFromFile(file)
        if (detected === null) {
            return null
        }
        if (detected === '') {
            // Not a mod jar (resource pack, shader pack, data pack...) or no metadata: use the provider's name
            const minecraft = this.primaryGameVersion(versionData)
            detected = minecraft !== '' && !label.includes(minecraft) ? `${minecraft}-${label}` : label
        }
        // Jar metadata often says "1.20" when the provider knows the exact "1.20.1"
        const apiMinecraft = this.primaryGameVersion(versionData)
        const match = /^(\d+\.\d+(?:\.\d+)?)(-.*)$/s.exec(detected)
        if (apiMinecraft !== '' && match && match[1] !== apiMinecraft && apiMinecraft.startsWith(`${match[1]}.`)) {
            detected = apiMinecraft + match[2]
        }
        return detected
    }

    /** First Minecraft version the provider lists for a file, ignoring loader and Java tags */
    protected static primaryGameVersion(versionData: VersionData | undefined): string {
        for (const gameVersion of versionData?.gameVersions ?? []) {
            if (typeof gameVersion === 'string' && /^\d+\.\d+/.test(gameVersion)) {
                return gameVersion
            }
        }
        return ''
    }

    protected static async http(url: string, options: RequestOptions = {}) {
        return request(url, { headers: this.apiHeaders(), timeout: 30, retries: 2, retryDelayMs: 250, ...options })
    }

    /** GET a provider API path. Returns the decoded JSON, or null on any failure. */
    protected static async request(path: string): Promise<Json> {
        try {
            const response = await this.http(this.apiUrl() + path)
            if (!response.ok) {
                return null
            }
            return JSON.parse(await response.text())
        } catch {
            return null
        }
    }

    /** GET a provider API path as text, or null on any failure */
    protected static async requestText(path: string): Promise<string | null> {
        try {
            const response = await this.http(this.apiUrl() + path)
            return response.ok ? await response.text() : null
        } catch {
            return null
        }
    }

    /** POST JSON to a provider API path. Returns the decoded JSON, or null on any failure. */
    protected static async post(path: string, body: unknown): Promise<Json> {
        try {
            const response = await this.http(this.apiUrl() + path, { method: 'POST', json: body })
            if (!response.ok) {
                return null
            }
            return JSON.parse(await response.text())
        } catch {
            return null
        }
    }

    /** Download a file to the given path. Returns an error message, or null on success. */
    static async download(url: string, destination: string): Promise<string | null> {
        return downloadFile(url, destination, this.downloadHeaders())
    }
}

export async function downloadFile(url: string, destination: string, headers: Record<string, string> = { 'User-Agent': `TechnicPack/TechnicSolder/${SOLDER_VERSION}` }): Promise<string | null> {
    try {
        const response = await request(url, { headers, timeout: 600 })
        if (!response.ok) {
            await response.buffer().catch(() => null)
            return `download failed with HTTP ${response.status}`
        }
        await saveTo(response, destination)
    } catch (error) {
        return `download failed: ${error instanceof ConnectionError || error instanceof Error ? error.message : String(error)}`
    }
    return fileSize(destination) ? null : 'the downloaded file is empty'
}

/** The side a downloaded jar declares it runs on, if any */
function jarEnvironment(file: string): string | null {
    const zip = ZipReader.open(file)
    return zip === null ? null : jarEnvironmentOf(zip)
}

/** Make a version string safe to use in a file name */
export function sanitizeVersion(version: string): string {
    return version.replace(/[^A-Za-z0-9._+-]+/g, '-').replace(/^-+|-+$/g, '')
}

/**
 * Pick the newest version matching the filters.
 *
 * @param versions Ordered newest first
 * @param releaseType "release"|"beta"|"alpha"|"any"|"" (empty = prefer release > beta > alpha)
 * @param loader Only consider files for this loader (or any of these), when the provider reports loaders
 */
export function latestStableVersionForGame(
    versions: Map<string, VersionData>,
    gameVersion: string,
    releaseType = '',
    loader: string | string[] = '',
): string | null {
    const candidates = new Map<string, string>()
    const wantedLoaders = (Array.isArray(loader) ? loader : [loader]).filter((value) => value !== '' && value !== '0')
    for (const [key, version] of versions) {
        const gameVersions = (version.gameVersions ?? []).map(String)
        if (gameVersion !== '' && !gameVersions.includes(gameVersion)) {
            continue
        }
        const loaders = version.loaders ?? []
        if (wantedLoaders.length > 0 && loaders.length > 0 && !wantedLoaders.some((wanted) => loaders.includes(wanted))) {
            continue
        }
        const type = version.versionType ?? 'release'
        if (releaseType !== '' && releaseType !== 'any' && type !== releaseType) {
            continue
        }
        candidates.set(key, type)
    }
    if (candidates.size === 0) {
        return null
    }
    const first = candidates.keys().next().value as string
    if (releaseType !== '') {
        return first
    }
    // Default: prefer release > beta > alpha
    for (const preferred of ['release', 'beta', 'alpha']) {
        for (const [key, type] of candidates) {
            if (type === preferred) {
                return key
            }
        }
    }
    return first
}

export function emptySearch(page = 1): SearchResult {
    return { mods: [], pagination: { currentPage: page, totalPages: 1, totalItems: 0 } }
}
