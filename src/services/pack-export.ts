import { SOLDER_VERSION } from '../config.js'
import { buildLoader } from '../models/build.js'
import { isNeededOn } from '../models/modversion.js'
import { buildsForModpack, modversionsForBuild, modversionsForBuilds } from '../models/relations.js'
import { only } from '../models/serialize.js'
import type { Build, Modpack, ModversionWithMod } from '../models/types.js'
import { Modrinth } from '../mods/providers/modrinth.js'
import { toIso8601String } from '../support/dates.js'
import { hashBuffer, tempFile } from '../support/files.js'
import { ucfirst } from '../support/str.js'
import { ZipReader, ZipWriter } from '../support/zip.js'
import { ModRepository } from './mod-repository.js'
import type { Progress } from './task-tracker.js'

/**
 * Exports builds as client/server zips or Modrinth/CurseForge modpacks, and modpacks as Solder JSON backups.
 */
export const BACKUP_FORMAT = 'solder-modpack'

export const FORMATS = {
    technic: {
        label: 'Client zip',
        description: 'Every mod, config and the loader merged, as the Technic launcher installs it',
        extension: 'zip',
        suffix: '',
    },
    server: {
        label: 'Server zip',
        description: 'Mods and configs plus the loader installer, for running a server',
        extension: 'zip',
        suffix: '-server',
    },
    mrpack: {
        label: 'Modrinth (.mrpack)',
        description: 'For Prism, ATLauncher and the Modrinth App',
        extension: 'mrpack',
        suffix: '',
    },
    curseforge: {
        label: 'CurseForge (.zip)',
        description: 'For the CurseForge app and other launchers',
        extension: 'zip',
        suffix: '-curseforge',
    },
} as const

export type ExportFormat = keyof typeof FORMATS

export function isExportFormat(format: string): format is ExportFormat {
    return Object.hasOwn(FORMATS, format)
}

/** Keys used for the loader in a Modrinth index's dependencies */
const MRPACK_LOADER_KEYS: Record<string, string> = {
    forge: 'forge',
    neoforge: 'neoforge',
    fabric: 'fabric-loader',
    quilt: 'quilt-loader',
}

/** Entry name for a file (not a directory) with a safe relative path, or null */
function safeEntryName(archive: ZipReader, index: number): string | null {
    const name = archive.getNameIndex(index).replaceAll('\\', '/')
    if (name === '' || name.endsWith('/') || name.startsWith('/') || name.includes('..')) {
        return null
    }
    return name
}

/** Copy entries between archives, optionally renaming or skipping them (rename returns null to skip) */
function copyEntries(source: ZipReader, out: ZipWriter, rename: ((name: string) => string | null) | null = null): void {
    for (let i = 0; i < source.numFiles; i++) {
        const name = safeEntryName(source, i)
        if (name === null) {
            continue
        }
        const target = rename ? rename(name) : name
        if (target !== null) {
            out.addFromString(target, source.getFromIndex(i))
        }
    }
}

export class PackExportService {
    private warnings: string[] = []
    private readonly repository = new ModRepository()

    constructor(private readonly progress: Progress | null = null) {}

    /** Export a build. The caller is responsible for deleting the returned file. */
    async exportBuild(build: Build, modpack: Modpack, format: string): Promise<{ path: string; filename: string; warnings: string[] }> {
        if (!isExportFormat(format)) {
            throw new Error(`Unknown export format "${format}"`)
        }
        this.warnings = []
        const modversions = await modversionsForBuild(build.id)
        const path = tempFile('solder_export_')
        const zip = new ZipWriter()
        try {
            switch (format) {
                case 'technic':
                    await this.writeClient(modversions, zip)
                    break
                case 'server':
                    await this.writeServer(build, modpack, modversions, zip)
                    break
                case 'mrpack':
                    await this.writeMrpack(build, modpack, modversions, zip)
                    break
                case 'curseforge':
                    await this.writeCurseForge(build, modpack, modversions, zip)
                    break
            }
            if (this.warnings.length > 0) {
                zip.addFromString('EXPORT_WARNINGS.txt', `Some files could not be exported:\n\n- ${this.warnings.join('\n- ')}\n`)
            }
            await this.report(1, 1, 'Compressing archive')
            await zip.save(path)
        } finally {
            this.repository.cleanup()
        }
        const version = build.version.replace(/[^A-Za-z0-9._+-]+/g, '-').replace(/^-+|-+$/g, '')
        const options = FORMATS[format]
        return {
            path,
            filename: `${modpack.slug}-${version}${options.suffix}.${options.extension}`,
            warnings: this.warnings,
        }
    }

    /** A JSON-serializable backup of a modpack, its builds and the mod versions they use */
    async backup(modpack: Modpack): Promise<Record<string, unknown>> {
        const builds = await buildsForModpack(modpack.id)
        const modversionsByBuild = await modversionsForBuilds(builds.map((build) => build.id))
        const mods = new Map<string, Record<string, unknown> & { versions: Map<string, unknown> }>()
        for (const build of builds) {
            for (const modversion of modversionsByBuild.get(build.id) ?? []) {
                const mod = modversion.mod
                if (!mods.has(mod.name)) {
                    mods.set(mod.name, { ...only(mod, ['name', 'pretty_name', 'author', 'description', 'link']), versions: new Map() })
                }
                mods.get(mod.name)!.versions.set(
                    modversion.version,
                    only(modversion, ['version', 'md5', 'filesize', 'provider', 'provider_project_id', 'provider_version_id', 'environment']),
                )
            }
        }
        return {
            format: BACKUP_FORMAT,
            format_version: 1,
            solder_version: SOLDER_VERSION,
            exported_at: toIso8601String(),
            modpack: only(modpack, ['name', 'slug', 'recommended', 'latest', 'hidden', 'private']),
            builds: [...builds]
                .sort((a, b) => a.id - b.id)
                .map((build) => ({
                    ...only(build, ['version', 'minecraft', 'forge', 'is_published', 'private', 'min_java', 'java_runtime', 'min_memory']),
                    mods: (modversionsByBuild.get(build.id) ?? []).map((modversion) => ({ name: modversion.mod.name, version: modversion.version })),
                })),
            mods: [...mods.values()].map((mod) => ({ ...mod, versions: [...mod.versions.values()] })),
        }
    }

    private async writeClient(modversions: ModversionWithMod[], out: ZipWriter): Promise<void> {
        for await (const [, archive] of this.archives(modversions, this.neededOn(modversions, 'client'))) {
            copyEntries(archive, out)
        }
    }

    private async writeServer(build: Build, modpack: Modpack, modversions: ModversionWithMod[], out: ZipWriter): Promise<void> {
        let installer: Buffer | null = null
        // Client-only mods (minimaps, shaders...) can crash a dedicated server, so they are left out
        for await (const [, archive] of this.archives(modversions, this.neededOn(modversions, 'server'))) {
            copyEntries(archive, out, (name) => {
                if (name === 'bin/modpack.jar') {
                    installer = archive.getFromName(name)
                }
                // bin/ holds the client launcher profile, which a server doesn't use
                return name.startsWith('bin/') ? null : name
            })
        }
        const loader = buildLoader(build, modversions)
        let readme = `${modpack.name} ${build.version} server\nMinecraft ${build.minecraft}\n\n`
        if (installer !== null) {
            const isInstaller = ZipReader.open(installer)?.locateName('install_profile.json') ?? false
            out.addFromString(isInstaller ? 'installer.jar' : 'forge-universal.jar', installer)
            readme += isInstaller
                ? 'Install the server with:\n\n    java -jar installer.jar --installServer\n\nthen start it with the run script the installer creates.\n'
                : `Place the vanilla minecraft_server.${build.minecraft}.jar next to forge-universal.jar and start the server with:\n\n    java -jar forge-universal.jar nogui\n`
        } else if (loader !== null && (loader.type === 'fabric' || loader.type === 'quilt')) {
            const site = loader.type === 'fabric' ? 'https://fabricmc.net/use/server/' : 'https://quiltmc.org/en/install/server/'
            readme += `${ucfirst(loader.type)} Loader ${loader.version}\n\nDownload the server launcher for Minecraft ${build.minecraft} from ${site}, place it in this folder and run it.\n`
        } else {
            readme += 'No mod loader was found in this build. Install the matching loader before starting the server.\n'
        }
        readme += '\nYou must accept the Minecraft EULA (eula.txt) before the server will start.\n'
        out.addFromString('README.txt', readme)
    }

    private async writeMrpack(build: Build, modpack: Modpack, modversions: ModversionWithMod[], out: ZipWriter): Promise<void> {
        // Pass 1: hash every jar in mods/ so Modrinth-hosted files can be referenced instead of bundled
        const environments = new Map(modversions.map((modversion) => [modversion.id, modversion.environment]))
        const overridesFolder = (modversionId: number) => {
            switch (environments.get(modversionId) ?? null) {
                case 'client':
                    return 'client-overrides'
                case 'server':
                    return 'server-overrides'
                default:
                    return 'overrides'
            }
        }
        const jars: { archive: number; name: string; sha1: string; sha512: string; size: number }[] = []
        for await (const [key, archive] of this.archives(modversions)) {
            for (let i = 0; i < archive.numFiles; i++) {
                const name = safeEntryName(archive, i)
                if (name === null || name.startsWith('bin/')) {
                    continue
                }
                if (/^mods\/[^/]+\.jar$/i.test(name)) {
                    const contents = archive.getFromIndex(i)
                    jars.push({ archive: key, name, sha1: hashBuffer(contents, 'sha1'), sha512: hashBuffer(contents, 'sha512'), size: contents.length })
                } else {
                    out.addFromString(`${overridesFolder(key)}/${name}`, archive.getFromIndex(i))
                }
            }
        }
        const hosted = await Modrinth.filesByHash(jars.map((jar) => jar.sha1))

        // Pass 2: bundle the jars Modrinth doesn't host
        const bundle = new Map<number, string[]>()
        const files: Record<string, unknown>[] = []
        for (const jar of jars) {
            const match = hosted.get(jar.sha1)
            if (match === undefined) {
                bundle.set(jar.archive, [...(bundle.get(jar.archive) ?? []), jar.name])
                continue
            }
            files.push({
                path: jar.name,
                hashes: { sha1: jar.sha1, sha512: jar.sha512 },
                env: {
                    client: environments.get(jar.archive) === 'server' ? 'unsupported' : 'required',
                    server: environments.get(jar.archive) === 'client' ? 'unsupported' : 'required',
                },
                downloads: [match.url],
                fileSize: jar.size,
            })
        }
        if (bundle.size > 0) {
            for await (const [key, archive] of this.archives(modversions, [...bundle.keys()])) {
                for (const name of bundle.get(key) ?? []) {
                    out.addFromString(`${overridesFolder(key)}/${name}`, archive.getFromName(name) ?? Buffer.alloc(0))
                }
            }
        }
        const dependencies: Record<string, string> = { minecraft: String(build.minecraft) }
        const loader = buildLoader(build, modversions)
        if (loader !== null) {
            dependencies[MRPACK_LOADER_KEYS[loader.type]] = loader.version
        } else {
            this.warnings.push('No mod loader was found in this build; set it in your launcher after importing.')
        }
        out.addFromString(
            'modrinth.index.json',
            JSON.stringify({ formatVersion: 1, game: 'minecraft', versionId: String(build.version), name: modpack.name, files, dependencies }, null, 4),
        )
    }

    private async writeCurseForge(build: Build, modpack: Modpack, modversions: ModversionWithMod[], out: ZipWriter): Promise<void> {
        // Mods imported from CurseForge are referenced by ID; everything else is bundled as overrides
        const files: { projectID: number; fileID: number; required: boolean }[] = []
        const bundled: number[] = []
        for (const modversion of modversions.filter((candidate) => isNeededOn(candidate, 'client'))) {
            if (
                modversion.provider === 'curseforge' &&
                /^\d+$/.test(String(modversion.provider_project_id)) &&
                /^\d+$/.test(String(modversion.provider_version_id))
            ) {
                files.push({ projectID: Number(modversion.provider_project_id), fileID: Number(modversion.provider_version_id), required: true })
            } else {
                bundled.push(modversion.id)
            }
        }
        for await (const [, archive] of this.archives(modversions, bundled)) {
            copyEntries(archive, out, (name) => (name.startsWith('bin/') ? null : `overrides/${name}`))
        }
        const loader = buildLoader(build, modversions)
        if (loader === null) {
            this.warnings.push('No mod loader was found in this build; set it in your launcher after importing.')
        }
        out.addFromString(
            'manifest.json',
            JSON.stringify(
                {
                    minecraft: {
                        version: String(build.minecraft),
                        modLoaders: loader === null ? [] : [{ id: `${loader.type}-${loader.version}`, primary: true }],
                    },
                    manifestType: 'minecraftModpack',
                    manifestVersion: 1,
                    name: modpack.name,
                    version: String(build.version),
                    author: '',
                    files,
                    overrides: 'overrides',
                },
                null,
                4,
            ),
        )
    }

    /** Open each mod version's zip in turn, with its modversion ID. Missing files are recorded as warnings. */
    private async *archives(modversions: ModversionWithMod[], onlyIds: number[] | null = null): AsyncGenerator<[number, ZipReader]> {
        const selected = modversions
            .filter((modversion) => onlyIds === null || onlyIds.includes(modversion.id))
            .sort((a, b) => (a.mod.name < b.mod.name ? -1 : a.mod.name > b.mod.name ? 1 : 0))
        for (const [index, modversion] of selected.entries()) {
            await this.report(index, selected.length, `Adding ${modversion.mod.pretty_name} ${modversion.version}`)
            const copy = await this.repository.localCopy(modversion)
            if ('error' in copy) {
                this.warnings.push(`${modversion.mod.name} ${modversion.version}: ${copy.error}`)
                continue
            }
            const zip = ZipReader.open(copy.path)
            if (zip === null) {
                this.warnings.push(`${modversion.mod.name} ${modversion.version}: not a valid zip`)
                continue
            }
            yield [modversion.id, zip]
        }
    }

    /** IDs of the build's mod versions used on the given side ("client" or "server") */
    private neededOn(modversions: ModversionWithMod[], side: string): number[] {
        return modversions.filter((modversion) => isNeededOn(modversion, side)).map((modversion) => modversion.id)
    }

    private async report(done: number, total: number, message: string): Promise<void> {
        await this.progress?.(done, total, message)
    }
}
