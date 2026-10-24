import { ZipReader } from '../support/zip.js'

/**
 * Reads mod metadata out of a mod jar to derive a "{minecraft}-{version}" version string.
 * Supports Fabric, Quilt, legacy Forge (mcmod.info), Forge/NeoForge (mods.toml) and Rift.
 * Minecraft versions may be the classic "1.20.1" form or the year-based "26.1" form.
 */

export interface DeclaredMod {
    id: string
    name: string
    version: string
    authors: string
    description: string
    url: string
    minecraft: string
    depends: string[]
    provides: string[]
}

export interface JarDescription {
    loaders: ('fabric' | 'quilt' | 'forge' | 'neoforge')[]
    mods: DeclaredMod[]
    nested: string[]
}

// Metadata comes from untrusted jars, so every value is treated as possibly anything
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

function isObject(value: unknown): value is Record<string, Json> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** PHP's (array) cast, iterated for its values */
function values(value: unknown): Json[] {
    if (value === null || value === undefined) {
        return []
    }
    if (Array.isArray(value)) {
        return value
    }
    if (isObject(value)) {
        return Object.values(value)
    }
    return [value]
}

/** array_keys((array) $value) */
function keys(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.map((_, index) => String(index))
    }
    return isObject(value) ? Object.keys(value) : value === null || value === undefined ? [] : ['0']
}

function json(zip: ZipReader, name: string): Json {
    const contents = zip.getText(name)
    if (contents === null) {
        return null
    }
    try {
        return JSON.parse(contents)
    } catch {
        return null
    }
}

/** A scalar as trimmed text, anything else as "" */
function text(value: unknown): string {
    if (typeof value === 'string') {
        return value.trim()
    }
    if (typeof value === 'number') {
        return String(value).trim()
    }
    if (typeof value === 'boolean') {
        return value ? '1' : ''
    }
    return ''
}

/** array_values(array_filter(array_map($text, $values))): PHP's array_filter also drops "0" */
function list(items: unknown[]): string[] {
    return items.map(text).filter((item) => item !== '' && item !== '0')
}

/** Whether a metadata value is a real version rather than empty or an unexpanded build placeholder */
function usable(value: unknown): value is string {
    return typeof value === 'string' && value.trim() !== '' && !value.includes('${')
}

function mod(fields: {
    id: unknown
    name: unknown
    version: unknown
    authors: unknown
    description: unknown
    url: unknown
    minecraft: unknown
    depends: unknown[]
    provides: unknown[]
}): DeclaredMod {
    return {
        id: text(fields.id),
        name: text(fields.name),
        version: text(fields.version),
        authors: text(fields.authors),
        description: text(fields.description),
        url: text(fields.url),
        minecraft: Array.isArray(fields.minecraft) ? list(fields.minecraft).join(' || ') : text(fields.minecraft),
        depends: list(fields.depends),
        provides: list(fields.provides),
    }
}

/** First match of a single-line TOML "key = value" in a block */
function tomlString(block: string, key: string): string {
    const match = new RegExp(`^\\s*${key}\\s*=\\s*["']{1,3}(.*?)["']{1,3}\\s*$`, 'm').exec(block)
    return match ? match[1].trim() : ''
}

function manifestVersion(zip: ZipReader): string {
    const manifest = zip.getText('META-INF/MANIFEST.MF')
    const match = manifest === null ? null : /^Implementation-Version:\s*(.+)$/m.exec(manifest)
    return match ? match[1].trim() : ''
}

/**
 * The loader a META-INF/mods.toml is for. NeoForge kept that file name until Minecraft 1.20.5,
 * so a mods.toml whose mods depend on "neoforge" is a NeoForge mod.
 */
function modsTomlLoader(toml: string): 'forge' | 'neoforge' {
    return /^\s*modId\s*=\s*["']neoforge["']/m.test(toml) ? 'neoforge' : 'forge'
}

/** Mods declared in a Forge/NeoForge mods.toml, with their mandatory dependencies */
function tomlMods(toml: string, zip: ZipReader): DeclaredMod[] {
    // Dependencies grouped by the mod that declares them
    const dependencies = new Map<string, { id: string; required: boolean; range: string }[]>()
    for (const [, owner, block] of toml.matchAll(/\[\[dependencies\.([^\]]+)\]\](.*?)(?=\[\[|$)/gs)) {
        const required = /^\s*(mandatory|required)\s*=\s*true/m.test(block) || /^\s*type\s*=\s*["']required["']/im.test(block)
        const key = owner.replace(/^["' ]+|["' ]+$/g, '')
        const list = dependencies.get(key) ?? []
        list.push({ id: tomlString(block, 'modId'), required, range: tomlString(block, 'versionRange') })
        dependencies.set(key, list)
    }

    const mods: DeclaredMod[] = []
    for (const [, block] of toml.matchAll(/\[\[mods\]\](.*?)(?=\[\[|$)/gs)) {
        const id = tomlString(block, 'modId')
        if (id === '') {
            continue
        }
        let version = tomlString(block, 'version')
        if (version === '${file.jarVersion}') {
            version = manifestVersion(zip)
        }
        let minecraft = ''
        const depends: string[] = []
        for (const dependency of dependencies.get(id) ?? []) {
            if (dependency.id === 'minecraft') {
                minecraft = dependency.range
            }
            if (dependency.required) {
                depends.push(dependency.id)
            }
        }
        mods.push(
            mod({
                id,
                name: tomlString(block, 'displayName'),
                version: usable(version) ? version : '',
                authors: tomlString(block, 'authors'),
                description: tomlString(block, 'description'),
                url: tomlString(block, 'displayURL'),
                minecraft,
                depends,
                provides: [],
            }),
        )
    }
    return mods
}

/**
 * Everything the jar says about itself: the loaders it targets, the mods it contains (with their required
 * dependencies) and any jars bundled inside it.
 */
export function describe(zip: ZipReader): JarDescription {
    const info: JarDescription = { loaders: [], mods: [], nested: [] }

    const fabric = json(zip, 'fabric.mod.json')
    if (isObject(fabric) && fabric.id !== undefined && fabric.id !== null) {
        info.loaders.push('fabric')
        info.mods.push(
            mod({
                id: fabric.id,
                name: fabric.name ?? '',
                version: fabric.version ?? '',
                authors: values(fabric.authors ?? [])
                    .map((author) => (isObject(author) ? (author.name ?? '') : String(author)))
                    .join(', '),
                description: fabric.description ?? '',
                url: fabric.contact?.homepage ?? fabric.contact?.sources ?? '',
                minecraft: fabric.depends?.minecraft ?? '',
                depends: keys(fabric.depends ?? []),
                provides: values(fabric.provides ?? []),
            }),
        )
        for (const jar of values(fabric.jars ?? [])) {
            info.nested.push(jar?.file ?? '')
        }
    }

    const quiltFile = json(zip, 'quilt.mod.json')
    const quilt = isObject(quiltFile) ? quiltFile.quilt_loader : null
    if (isObject(quilt) && quilt.id !== undefined && quilt.id !== null) {
        info.loaders.push('quilt')
        const depends: string[] = []
        let minecraft: unknown = ''
        for (const dependency of values(quilt.depends ?? [])) {
            const id = isObject(dependency) ? (dependency.id ?? '') : String(dependency)
            if (isObject(dependency) && dependency.optional) {
                continue
            }
            depends.push(id)
            if (id === 'minecraft' && isObject(dependency)) {
                minecraft = dependency.versions ?? ''
            }
        }
        info.mods.push(
            mod({
                id: quilt.id,
                name: quilt.metadata?.name ?? '',
                version: quilt.version ?? '',
                authors: keys(quilt.metadata?.contributors ?? []).join(', '),
                description: quilt.metadata?.description ?? '',
                url: quilt.metadata?.contact?.homepage ?? '',
                minecraft,
                depends,
                provides: values(quilt.provides ?? []).map((provided) => (isObject(provided) ? (provided.id ?? '') : String(provided))),
            }),
        )
        for (const jar of values(quilt.jars ?? [])) {
            info.nested.push(String(jar))
        }
    }

    for (const [file, loader] of [['META-INF/neoforge.mods.toml', 'neoforge'], ['META-INF/mods.toml', null]] as const) {
        const toml = zip.getText(file)
        if (toml === null) {
            continue
        }
        info.loaders.push(loader ?? modsTomlLoader(toml))
        info.mods.push(...tomlMods(toml, zip))
    }

    const jarJar = json(zip, 'META-INF/jarjar/metadata.json')
    for (const jar of values(isObject(jarJar) ? (jarJar.jars ?? []) : [])) {
        info.nested.push(jar?.path ?? '')
    }

    const mcmod = json(zip, 'mcmod.info')
    const legacyMods = Array.isArray(mcmod) ? mcmod : isObject(mcmod) ? (mcmod.modList ?? []) : []
    for (const legacy of values(legacyMods)) {
        if (!isObject(legacy) || !legacy.modid) {
            continue
        }
        info.loaders.push('forge')
        info.mods.push(
            mod({
                id: legacy.modid,
                name: legacy.name ?? '',
                version: usable(legacy.version) ? legacy.version : '',
                authors: values(legacy.authorList ?? legacy.authors ?? []).map((author) => String(author)).join(', '),
                description: legacy.description ?? '',
                url: legacy.url ?? '',
                minecraft: usable(legacy.mcversion) ? legacy.mcversion : '',
                depends: values(legacy.requiredMods ?? []).map((dependency) => String(dependency).split('@')[0]),
                provides: [],
            }),
        )
    }

    info.loaders = [...new Set(info.loaders)]
    info.nested = info.nested.filter((name) => typeof name === 'string' && name !== '' && name !== '0')
    return info
}

/**
 * The side a jar declares it runs on: "client", "server", or null for both or unknown.
 * Only Fabric and Quilt declare this; Forge mods are assumed to run on both.
 */
export function environment(zip: ZipReader): 'client' | 'server' | null {
    const fabric = json(zip, 'fabric.mod.json')
    const quilt = json(zip, 'quilt.mod.json')
    const declared = (isObject(fabric) ? fabric.environment : undefined) ?? (isObject(quilt) ? quilt.minecraft?.environment : undefined)
    switch (declared) {
        case 'client':
            return 'client'
        case 'server':
        case 'dedicated_server':
            return 'server'
        default:
            return null
    }
}

/** Pull the first concrete Minecraft version out of a version range such as ">=1.20 <1.21", "~26.1" or "1.20.x" */
export function minecraftVersionFromRange(range: unknown): string {
    if (Array.isArray(range)) {
        range = range[0] ?? ''
    }
    const match = typeof range === 'string' ? /(\d+\.\d+(?:\.\d+)?)/.exec(range) : null
    return match ? match[1] : ''
}

function combine(minecraft: string, version: string): string {
    version = version.trim()
    // Avoid "1.20.1-1.20.1-2.0" when the mod already prefixes its own version
    if (minecraft === '' || version.startsWith(`${minecraft}-`)) {
        return version
    }
    return `${minecraft}-${version}`
}

function fromFabric(zip: ZipReader): string | null {
    const data = json(zip, 'fabric.mod.json')
    const version = isObject(data) ? data.version : null
    if (!usable(version)) {
        return null
    }
    return combine(minecraftVersionFromRange(data.depends?.minecraft ?? ''), version)
}

function fromQuilt(zip: ZipReader): string | null {
    const data = json(zip, 'quilt.mod.json')
    const loader = isObject(data) ? data.quilt_loader : null
    const version = isObject(loader) ? loader.version : null
    if (!usable(version)) {
        return null
    }
    let minecraft = ''
    for (const dependency of values(loader.depends ?? [])) {
        if (isObject(dependency) && (dependency.id ?? '') === 'minecraft') {
            minecraft = minecraftVersionFromRange(dependency.versions ?? '')
            break
        }
    }
    return combine(minecraft, version)
}

function fromMcmodInfo(zip: ZipReader): string | null {
    const data = json(zip, 'mcmod.info')
    // Either a bare list of mods or {"modListVersion": 2, "modList": [...]}
    const mods = Array.isArray(data) ? data : isObject(data) ? (data.modList ?? []) : []
    const first = values(mods)[0]
    if (!isObject(first) || !usable(first.version)) {
        return null
    }
    return combine(usable(first.mcversion) ? first.mcversion : '', first.version)
}

function fromRift(zip: ZipReader): string | null {
    const data = json(zip, 'riftmod.json')
    const version = isObject(data) ? data.version : null
    return usable(version) ? version : null
}

function fromModsToml(zip: ZipReader): string | null {
    const toml = zip.getText('META-INF/neoforge.mods.toml') ?? zip.getText('META-INF/mods.toml')
    if (toml === null) {
        return null
    }
    let version = ''
    const modsBlock = /\[\[mods\]\](.*?)(?=\[\[|$)/s.exec(toml)
    const versionMatch = modsBlock ? /^\s*version\s*=\s*["']([^"']+)["']/m.exec(modsBlock[1]) : null
    if (versionMatch) {
        version = versionMatch[1]
    }
    if (version === '${file.jarVersion}') {
        version = manifestVersion(zip)
    }
    if (!usable(version)) {
        return null
    }
    let minecraft = ''
    for (const [, block] of toml.matchAll(/\[\[dependencies\.[^\]]+\]\](.*?)(?=\[\[|$)/gs)) {
        const range = /versionRange\s*=\s*["']([^"']+)["']/i.exec(block)
        if (/modId\s*=\s*["']minecraft["']/i.test(block) && range) {
            minecraft = minecraftVersionFromRange(range[1])
            break
        }
    }
    return combine(minecraft, version)
}

/** Detect the version from an open archive. Returns an empty string when no metadata is found. */
export function detectVersion(zip: ZipReader): string {
    return fromFabric(zip) ?? fromQuilt(zip) ?? fromMcmodInfo(zip) ?? fromRift(zip) ?? fromModsToml(zip) ?? ''
}

/** Detect the version of the jar at the given path. Returns null when the file is not a readable archive. */
export function detectVersionFromFile(path: string): string | null {
    const zip = ZipReader.open(path)
    return zip === null ? null : detectVersion(zip)
}

export const JarMetadata = { describe, environment, minecraftVersionFromRange, detectVersion, detectVersionFromFile }
