import { closeSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from '../config.js'
import { db } from '../database/prisma.js'
import { syncBuildModversions } from '../models/relations.js'
import type { Build, Modpack } from '../models/types.js'
import { ImportedModData } from '../mods/imported-mod-data.js'
import { downloadFile, type ProviderClass } from '../mods/mod-provider.js'
import { CurseForge } from '../mods/providers/curseforge.js'
import { Fabric, Quilt } from '../mods/providers/fabric.js'
import { Forge } from '../mods/providers/forge.js'
import { Modrinth } from '../mods/providers/modrinth.js'
import { NeoForge } from '../mods/providers/neoforge.js'
import { appUrl } from '../http/urls.js'
import { Cache } from '../support/cache.js'
import { fileSize, hashFile, isUrl, removeFile, tempFile } from '../support/files.js'
import { basename, filenameWithoutExtension, headline, slug as toSlug } from '../support/str.js'
import { ZipReader, ZipWriter } from '../support/zip.js'
import { BACKUP_FORMAT } from './pack-export.js'
import type { Progress } from './task-tracker.js'

/**
 * Imports a modpack from a CurseForge zip, a Modrinth .mrpack, or a Solder JSON backup.
 * Mods are added to the mod library, the pack's mod loader and override files (configs, scripts...) are stored as
 * mods of their own, and everything is linked to a new build of a new, hidden modpack, or to a new (or
 * overwritten) build of an existing modpack.
 */
export type ImportResult =
    | { error: string }
    | { conflict: string }
    | { modpack_id: number; build_id: number; imported: number; skipped: number; errors: string[] }

export type ImportLog = (level: 'info' | 'error', message: string) => void | Promise<void>

// Archive manifests are untrusted JSON
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

export class PackImportService {
    private errors: string[] = []
    private imported = 0
    private skipped = 0
    /** The existing modpack to add the build to, or null to create a modpack */
    private into: Modpack | null = null
    /** Build version to use instead of the archive's */
    private buildVersion: string | null = null
    /** Whether to replace an existing build with the same version rather than stop */
    private overwrite = false

    constructor(
        private readonly progress: Progress | null = null,
        /** Receives each step and problem, as 'info' or 'error' */
        private readonly log: ImportLog | null = null,
    ) {}

    async importFromPath(path: string, name: string, slug: string): Promise<ImportResult> {
        return this.process(path, name, slug)
    }

    /**
     * Import the archive as a build of an existing modpack. When the modpack already has a build with that version,
     * nothing is changed and a conflict is returned unless overwrite is set.
     *
     * @param version Build version to use instead of the one in the archive
     */
    async importIntoModpack(path: string, modpack: Modpack, version: string | null = null, overwrite = false): Promise<ImportResult> {
        this.into = modpack
        this.buildVersion = version
        this.overwrite = overwrite
        try {
            return await this.process(path, '', '')
        } finally {
            this.into = null
            this.buildVersion = null
            this.overwrite = false
        }
    }

    async importFromUrl(url: string, name: string, slug: string): Promise<ImportResult> {
        const tmpPath = tempFile('solder_pack_')
        try {
            const error = await downloadFile(url, tmpPath)
            if (error !== null) {
                return { error: `Could not download the archive: ${error}` }
            }
            return await this.process(tmpPath, name, slug)
        } finally {
            removeFile(tmpPath)
        }
    }

    private async process(path: string, name: string, slug: string): Promise<ImportResult> {
        this.errors = []
        this.imported = 0
        this.skipped = 0

        const backup = this.readSolderBackup(path)
        if (backup !== null) {
            if (this.into !== null) {
                return { error: 'A Solder backup holds a whole modpack, so it can only be restored as a new modpack.' }
            }
            return this.importSolderBackup(backup, name, slug)
        }

        const zip = ZipReader.open(path)
        if (zip === null) {
            return { error: 'Could not open the archive. Upload a CurseForge .zip, a Modrinth .mrpack or a Solder .json backup.' }
        }
        if (zip.locateName('modrinth.index.json')) {
            return this.importModrinth(zip, name, slug)
        }
        if (zip.locateName('manifest.json')) {
            return this.importCurseForge(zip, name, slug)
        }
        return { error: 'Unrecognized modpack format. Expected a CurseForge .zip (manifest.json) or a Modrinth .mrpack (modrinth.index.json).' }
    }

    private async importCurseForge(zip: ZipReader, name: string, slug: string): Promise<ImportResult> {
        const manifest = parseJson(zip.getText('manifest.json'))
        if (!isObject(manifest) || (manifest.manifestType ?? 'minecraftModpack') !== 'minecraftModpack') {
            return { error: 'manifest.json is not a valid CurseForge modpack manifest.' }
        }
        const files: Json[] = (Array.isArray(manifest.files) ? manifest.files : []).filter((file: Json) => file?.fileID && (file.required ?? true) !== false)
        if (files.length > 0 && !CurseForge.hasApiKey()) {
            return { error: 'Importing CurseForge modpacks requires a CurseForge API key. Set CURSEFORGE_API_KEY in your .env file.' }
        }
        const minecraft = String(manifest.minecraft?.version ?? '')
        const loaders: Json[] = Array.isArray(manifest.minecraft?.modLoaders) ? manifest.minecraft.modLoaders : []
        const primaryLoader = loaders.find((loader) => loader?.primary === true) ?? loaders[0] ?? null
        const [loaderType, loaderVersion] = parseCurseForgeLoader(String(primaryLoader?.id ?? ''))

        const build = await this.prepareBuild(name || (manifest.name ?? 'Imported Pack'), slug, String(manifest.version ?? '1.0'), minecraft, primaryLoader?.id ?? '')
        if (!('id' in build)) {
            return build
        }
        const modpack = await db.modpack.findUniqueOrThrow({ where: { id: build.modpack_id } })
        await this.note(
            `CurseForge pack ${manifest.name ?? ''} ${manifest.version ?? ''}: ${files.length} mods for Minecraft ${minecraft || '?'}, ${(primaryLoader?.id ?? '') || 'no mod loader'}`,
        )

        const modversionIds: number[] = []
        await this.report(0, files.length, 'Looking up mods on CurseForge')
        const mods = await CurseForge.modsForFiles(files.map((file) => file.fileID))
        for (const [index, file] of files.entries()) {
            const projectId = String(file.projectID ?? '')
            const fileId = String(file.fileID)
            const modData = mods.get(projectId)
            if (modData === undefined || !modData.versions.has(fileId)) {
                await this.fail(`CurseForge file ${fileId} (project ${projectId}) could not be found`)
                continue
            }
            await this.report(index, files.length, `Downloading ${modData.name}`)
            await this.installVersion(CurseForge, projectId, fileId, modData, modversionIds)
        }
        await this.installLoader(loaderType, loaderVersion, minecraft, modversionIds)
        await this.installOverrides(zip, [String(manifest.overrides ?? 'overrides') || 'overrides'], modpack, build.version, modversionIds)
        await syncBuildModversions(build.id, [...new Set(modversionIds)])
        return this.result(modpack, build)
    }

    private async importModrinth(zip: ZipReader, name: string, slug: string): Promise<ImportResult> {
        const index = parseJson(zip.getText('modrinth.index.json'))
        if (!isObject(index) || (index.game ?? 'minecraft') !== 'minecraft') {
            return { error: 'modrinth.index.json is not a valid Minecraft modpack index.' }
        }
        const dependencies: Record<string, unknown> = isObject(index.dependencies) ? index.dependencies : {}
        const minecraft = String(dependencies.minecraft ?? '')
        let loaderType = ''
        let loaderVersion = ''
        for (const [key, type] of [['neoforge', 'neoforge'], ['forge', 'forge'], ['fabric-loader', 'fabric'], ['quilt-loader', 'quilt']]) {
            if (dependencies[key]) {
                loaderType = type
                loaderVersion = String(dependencies[key])
                break
            }
        }

        const build = await this.prepareBuild(name || (index.name ?? 'Imported Pack'), slug, String(index.versionId ?? '1.0'), minecraft, loaderType ? `${loaderType}-${loaderVersion}` : '')
        if (!('id' in build)) {
            return build
        }
        const modpack = await db.modpack.findUniqueOrThrow({ where: { id: build.modpack_id } })
        const modversionIds: number[] = []

        // Skip files the client doesn't use (server-only mods)
        const files: Json[] = (Array.isArray(index.files) ? index.files : []).filter(
            (file: Json) => (file?.env?.client ?? 'required') !== 'unsupported' && Array.isArray(file?.downloads) && file.downloads.length > 0,
        )
        const modrinthFiles: [Json, string, string][] = []
        const otherFiles: Json[] = []
        for (const file of files) {
            const match = /^https:\/\/cdn\.modrinth\.com\/data\/([^/]+)\/versions\/([^/]+)\//.exec(String(file.downloads[0]))
            if (match) {
                modrinthFiles.push([file, match[1], match[2]])
            } else {
                otherFiles.push(file)
            }
        }
        const total = files.length
        await this.note(
            `Modrinth pack ${index.name ?? ''} ${index.versionId ?? ''}: ${total} files for Minecraft ${minecraft || '?'}, ${loaderType ? `${loaderType} ${loaderVersion}` : 'no mod loader'}`,
        )
        await this.report(0, total, 'Looking up mods on Modrinth')
        const mods = await Modrinth.modsForVersions(modrinthFiles.map(([, , versionId]) => versionId))
        let done = 0
        for (const [file, projectId, versionId] of modrinthFiles) {
            const modData = mods.get(projectId)
            const versionData = modData?.versions.get(versionId)
            if (modData === undefined || versionData === undefined) {
                // Not resolvable through the API (deleted project?): fall back to the direct download
                otherFiles.push(file)
                continue
            }
            versionData.folder = folderFromPath(file.path ?? '')
            versionData.environment = environmentFromIndex(file) ?? modData.environment
            versionData.filename = basename(file.path ?? versionData.filename)
            await this.report(done++, total, `Downloading ${modData.name}`)
            await this.installVersion(Modrinth, projectId, versionId, modData, modversionIds)
        }
        for (const file of otherFiles) {
            await this.report(done++, total, `Downloading ${basename(String(file.path ?? 'file'))}`)
            await this.installDirectFile(file, minecraft, modversionIds)
        }
        await this.installLoader(loaderType, loaderVersion, minecraft, modversionIds)
        await this.installOverrides(zip, ['overrides', 'client-overrides'], modpack, build.version, modversionIds)
        await syncBuildModversions(build.id, [...new Set(modversionIds)])
        return this.result(modpack, build)
    }

    /** Install a file listed in a .mrpack that isn't hosted on Modrinth, using its download URL directly */
    private async installDirectFile(file: Json, minecraft: string, modversionIds: number[]): Promise<void> {
        const path = String(file.path ?? basename(file.downloads[0]))
        const filename = basename(path)
        const slug = slugFromFilename(filename)
        const modData = new ImportedModData()
        modData.id = slug
        modData.slug = slug
        modData.name = headline(slug)
        modData.versions.set(filename, {
            url: file.downloads[0],
            filename,
            label: filenameWithoutExtension(filename),
            gameVersions: minecraft !== '' ? [minecraft] : [],
            folder: folderFromPath(path),
            environment: environmentFromIndex(file),
            sha1: file.hashes?.sha1 ?? null,
            // Not actually from Modrinth, so don't record it as a Modrinth file
            untracked: true,
        })
        await this.installVersion(Modrinth, slug, filename, modData, modversionIds)
    }

    private async installVersion(provider: ProviderClass, modId: string, versionKey: string, modData: ImportedModData, modversionIds: number[]): Promise<void> {
        const result = await provider.install(modId, [versionKey], modData)
        const id = result.modversionIds.get(versionKey)
        if (id !== undefined) {
            modversionIds.push(id)
            this.imported++
            await this.note(`Added ${modData.name} ${modData.versions.get(versionKey)?.label ?? versionKey}`)
        } else {
            await this.fail(...(result.errors.length > 0 ? result.errors : [`${modData.name}: import failed`]))
        }
    }

    /** Add the pack's mod loader (bin/modpack.jar or bin/version.json) to the build */
    private async installLoader(type: string, version: string, minecraft: string, modversionIds: number[]): Promise<void> {
        if (type === '' || version === '' || minecraft === '') {
            return
        }
        const provider = ({ forge: Forge, neoforge: NeoForge, fabric: Fabric, quilt: Quilt } as Record<string, ProviderClass>)[type] ?? null
        const loaderData = provider ? await provider.mod(minecraft) : null
        const candidates =
            type === 'forge'
                ? [`${minecraft}-forge-${version}`, `${minecraft}-forge-${version}-${minecraft}`]
                : type === 'neoforge'
                  ? [`neoforge-${version}`, `forge-${minecraft}-${version}`]
                  : [`${minecraft}-${version}`]
        await this.report(1, 1, `Adding ${type} ${version}`)
        const key = candidates.find((candidate) => loaderData?.versions.has(candidate))
        if (key === undefined || provider === null || loaderData === null) {
            await this.fail(`Could not find ${type} ${version} for Minecraft ${minecraft}. Add the mod loader to the build manually.`)
            return
        }
        await this.installVersion(provider, minecraft, key, loaderData, modversionIds)
    }

    /**
     * Store the pack's override files (configs, scripts, resource packs...) as a mod linked to the build.
     *
     * @param prefixes Folders inside the archive whose contents are extracted to the game folder
     */
    private async installOverrides(source: ZipReader, prefixes: string[], modpack: Modpack, version: string, modversionIds: number[]): Promise<void> {
        const entries = new Map<string, number>()
        for (let i = 0; i < source.numFiles; i++) {
            const entryName = source.getNameIndex(i)
            for (const rawPrefix of prefixes) {
                const prefix = `${rawPrefix.replace(/^\/+|\/+$/g, '')}/`
                if (entryName.startsWith(prefix) && !entryName.endsWith('/')) {
                    const relative = entryName.slice(prefix.length)
                    // Guard against path traversal in untrusted archives
                    if (relative !== '' && !relative.includes('..')) {
                        entries.set(relative, i)
                    }
                }
            }
        }
        if (entries.size === 0) {
            return
        }
        const repo = config.solder.repo_location
        if (isUrl(repo)) {
            await this.fail("The mod repository is a remote URL, so the pack's override files could not be saved.")
            return
        }
        const modSlug = toSlug(`${modpack.slug}-overrides`)
        let mod = await db.mod.findUnique({ where: { name: modSlug } })
        mod ??= await db.mod.create({
            data: {
                name: modSlug,
                pretty_name: `${modpack.name} Overrides`,
                description: `Configs and other files bundled with the ${modpack.name} modpack.`,
            },
        })
        await Cache.forget('mods')

        const versionName = version.replace(/[^A-Za-z0-9._+-]+/g, '-').replace(/^-+|-+$/g, '') || '1.0'
        const finalPath = `${repo}mods/${modSlug}/${modSlug}-${versionName}.zip`
        mkdirSync(dirname(finalPath), { recursive: true, mode: 0o775 })
        const out = new ZipWriter()
        for (const [relative, index] of entries) {
            out.addFromString(relative, source.getFromIndex(index))
        }
        try {
            await out.save(finalPath)
        } catch {
            await this.fail(`Could not write ${finalPath}`)
            return
        }
        const attributes = { filesize: fileSize(finalPath), md5: await hashFile(finalPath) }
        const existing = await db.modversion.findFirst({ where: { mod_id: mod.id, version: versionName } })
        const modversion = existing
            ? await db.modversion.update({ where: { id: existing.id }, data: attributes })
            : await db.modversion.create({ data: { mod_id: mod.id, version: versionName, ...attributes } })
        await this.note(`Saved ${entries.size} override files (configs, scripts...) as ${modSlug} ${versionName}`)
        modversionIds.push(modversion.id)
    }

    /** Decode a Solder JSON backup, or return null when the file isn't one */
    private readSolderBackup(path: string): Record<string, Json> | null {
        let start = ''
        try {
            const handle = openSync(path, 'r')
            const buffer = Buffer.alloc(64)
            const read = readSync(handle, buffer, 0, 64, 0)
            closeSync(handle)
            start = buffer.subarray(0, read).toString('utf8').trimStart()
        } catch {
            return null
        }
        if (!start.startsWith('{')) {
            return null
        }
        const data = parseJson(readFileSync(path, 'utf8'))
        return isObject(data) && data.format === BACKUP_FORMAT ? data : null
    }

    /** Recreate a modpack from a Solder JSON backup. Mod files are expected to already be in the mod repository. */
    private async importSolderBackup(backup: Record<string, Json>, name: string, slug: string): Promise<ImportResult> {
        const source: Record<string, Json> = isObject(backup.modpack) ? backup.modpack : {}
        let modpack = await this.createModpack(slug, name || (source.name ?? 'Imported Pack'))
        const fill: Record<string, unknown> = {}
        for (const key of ['recommended', 'latest', 'private'] as const) {
            if (key in source) {
                fill[key] = key === 'private' ? Boolean(source[key]) : source[key]
            }
        }
        modpack = await db.modpack.update({ where: { id: modpack.id }, data: fill })

        const modversionsByKey = new Map<string, number>()
        for (const modData of Array.isArray(backup.mods) ? backup.mods : []) {
            if (!modData?.name) {
                continue
            }
            let mod = await db.mod.findUnique({ where: { name: modData.name } })
            if (mod === null) {
                const attributes: Record<string, unknown> = { pretty_name: modData.name }
                for (const key of ['pretty_name', 'author', 'description', 'link']) {
                    if (key in modData) {
                        attributes[key] = modData[key]
                    }
                }
                mod = await db.mod.create({ data: { name: modData.name, ...attributes } })
            }
            for (const versionData of Array.isArray(modData.versions) ? modData.versions : []) {
                let modversion = await db.modversion.findFirst({ where: { mod_id: mod.id, version: String(versionData.version) } })
                if (modversion === null) {
                    const attributes: Record<string, unknown> = { md5: versionData.md5 ?? '', filesize: versionData.filesize ?? 0 }
                    for (const key of ['provider', 'provider_project_id', 'provider_version_id', 'environment']) {
                        if (key in versionData) {
                            attributes[key] = versionData[key]
                        }
                    }
                    modversion = await db.modversion.create({ data: { mod_id: mod.id, version: String(versionData.version), ...attributes } as never })
                }
                modversionsByKey.set(`${mod.name}\0${modversion.version}`, modversion.id)
                this.imported++
            }
        }
        await Cache.forget('mods')

        let lastBuild: Build | null = null
        for (const buildData of Array.isArray(backup.builds) ? backup.builds : []) {
            const attributes: Record<string, unknown> = {}
            for (const key of ['version', 'minecraft', 'forge', 'is_published', 'private', 'min_java', 'java_runtime', 'min_memory']) {
                if (key in buildData) {
                    attributes[key] = ['is_published', 'private'].includes(key) ? Boolean(buildData[key]) : buildData[key]
                }
            }
            const build = await db.build.create({ data: { ...attributes, modpack_id: modpack.id } as never })
            const ids: number[] = []
            for (const entry of Array.isArray(buildData.mods) ? buildData.mods : []) {
                const id = modversionsByKey.get(`${entry?.name ?? ''}\0${entry?.version ?? ''}`)
                if (id === undefined) {
                    await this.fail(`Build ${build.version}: ${entry?.name} ${entry?.version} is missing from the backup`)
                    continue
                }
                ids.push(id)
            }
            await syncBuildModversions(build.id, ids)
            lastBuild = build
        }
        if (lastBuild === null) {
            return { error: 'The backup contains no builds.' }
        }
        return this.result(modpack, lastBuild)
    }

    /**
     * The build to import into: a new build of a new modpack, a new build of the modpack being imported into, or,
     * when overwriting, that modpack's build with the same version.
     */
    private async prepareBuild(name: string, slug: string, version: string, minecraft: string, loader: string): Promise<Build | { conflict: string }> {
        version = this.buildVersion || version
        if (this.into === null) {
            return this.createBuild(await this.createModpack(slug, name), version, minecraft, loader)
        }
        const existing = await db.build.findFirst({ where: { modpack_id: this.into.id, version } })
        if (existing === null) {
            await this.note(`Adding build ${version} to ${this.into.name}`)
            return this.createBuild(this.into, version, minecraft, loader)
        }
        if (!this.overwrite) {
            return { conflict: version }
        }
        await this.note(`Overwriting build ${version} of ${this.into.name}; its mods are replaced with the pack's`)
        return db.build.update({ where: { id: existing.id }, data: { minecraft, forge: loader || null } })
    }

    private async createModpack(slug: string, name: string): Promise<Modpack> {
        return db.modpack.create({
            data: {
                name,
                slug,
                hidden: true,
                icon_url: appUrl('/resources/default/icon.png'),
                logo_url: appUrl('/resources/default/logo.png'),
                background_url: appUrl('/resources/default/background.jpg'),
            },
        })
    }

    private async createBuild(modpack: Modpack, version: string, minecraft: string, loader: string): Promise<Build> {
        return db.build.create({ data: { modpack_id: modpack.id, version, minecraft, forge: loader || null, is_published: false } })
    }

    private async report(done: number, total: number, message: string): Promise<void> {
        await this.progress?.(done, total, message)
    }

    private async fail(...messages: string[]): Promise<void> {
        this.errors.push(...messages)
        this.skipped++
        for (const message of messages) {
            await this.log?.('error', message)
        }
    }

    private async note(message: string): Promise<void> {
        await this.log?.('info', message)
    }

    private result(modpack: Modpack, build: Build): ImportResult {
        return { modpack_id: modpack.id, build_id: build.id, imported: this.imported, skipped: this.skipped, errors: this.errors }
    }
}

function parseJson(text: string | null): Json {
    if (text === null) {
        return null
    }
    try {
        return JSON.parse(text)
    } catch {
        return null
    }
}

function isObject(value: unknown): value is Record<string, Json> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Split a CurseForge loader id such as "forge-47.2.0" or "fabric-0.15.11" into [type, version] */
function parseCurseForgeLoader(id: string): [string, string] {
    const match = /^(neoforge|forge|fabric|quilt)-(.+)$/.exec(id)
    return match ? [match[1], match[2]] : ['', '']
}

/** "client" when a .mrpack file isn't used on servers. (Files the client doesn't use are skipped entirely.) */
function environmentFromIndex(file: Json): string | null {
    return (file?.env?.server ?? 'required') === 'unsupported' ? 'client' : null
}

/** dirname() of the path, trimmed of "./" characters, defaulting to "mods" */
function folderFromPath(path: string): string {
    const normalized = path.replaceAll('\\', '/')
    const slash = normalized.lastIndexOf('/')
    const folder = (slash === -1 ? '.' : normalized.slice(0, slash) || '/').replace(/^[./]+|[./]+$/g, '')
    return folder.includes('..') ? 'mods' : folder || 'mods'
}

function slugFromFilename(filename: string): string {
    const base = filenameWithoutExtension(filename)
    const slugParts: string[] = []
    for (const part of base.split(/[-_+ ]/)) {
        if (/^v?\d/i.test(part)) {
            break
        }
        slugParts.push(part)
    }
    return toSlug(slugParts.join('-')) || toSlug(base)
}
