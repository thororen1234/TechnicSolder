import { buildLoader } from '../models/build.js'
import { modversionsForBuild } from '../models/relations.js'
import type { Build, ModversionWithMod } from '../models/types.js'
import { describe as describeJarMetadata, type DeclaredMod } from '../mods/jar-metadata.js'
import { satisfies } from '../mods/version-range.js'
import { Cache } from '../support/cache.js'
import { basename } from '../support/str.js'
import { ZipReader } from '../support/zip.js'
import { ModRepository } from './mod-repository.js'

/**
 * Checks a build for problems that stop it from launching: missing files, mods for the wrong loader or Minecraft
 * version, missing required dependencies and mods included twice.
 */
export interface Issue {
    severity: 'error' | 'warning'
    mod: string | null
    message: string
}

interface JarInfo {
    file: string
    loaders: string[]
    mods: DeclaredMod[]
    provides: string[]
}

/** Dependencies satisfied by the game or the loader itself */
const BUILT_IN = ['minecraft', 'java', 'fabricloader', 'fabric-loader', 'quilt_loader', 'quilt-loader', 'forge', 'neoforge', 'javafml', 'lowcodefml', 'mcp', 'fml']

/** How deep to follow jars bundled inside jars */
const NESTING_DEPTH = 3

const LOADER_MODS = ['forge', 'neoforge', 'fabric-loader', 'quilt-loader']

function issue(severity: Issue['severity'], mod: string | null, message: string): Issue {
    return { severity, mod, message }
}

function describeJar(contents: Buffer, file: string, depth: number): JarInfo {
    const zip = ZipReader.open(contents)
    if (zip === null) {
        return { file, loaders: [], mods: [], provides: [] }
    }
    const info = describeJarMetadata(zip)
    const provides: string[] = []
    for (const mod of info.mods) {
        provides.push(mod.id, ...mod.provides)
    }
    if (depth < NESTING_DEPTH) {
        for (const nested of info.nested) {
            const nestedContents = zip.getFromName(nested)
            if (nestedContents !== null) {
                provides.push(...describeJar(nestedContents, basename(nested), depth + 1).provides)
            }
        }
    }
    return { file, loaders: info.loaders, mods: info.mods, provides: [...new Set(provides)] }
}

/** Describe every jar in a mod version's zip (mods/*.jar) */
function readModversion(zipPath: string): JarInfo[] {
    const zip = ZipReader.open(zipPath)
    if (zip === null) {
        return []
    }
    const jars: JarInfo[] = []
    for (let i = 0; i < zip.numFiles; i++) {
        const name = zip.getNameIndex(i)
        if (/^mods\/[^/]+\.jar$/i.test(name)) {
            jars.push(describeJar(zip.getFromIndex(i), basename(name), 0))
        }
    }
    return jars
}

/** Loaders whose mods run in this build. Quilt runs Fabric mods; NeoForge for 1.20.1 runs Forge mods. */
function compatibleLoaders(build: Pick<Build, 'minecraft'>, loader: string | null): string[] {
    switch (loader) {
        case null:
            return []
        case 'quilt':
            return ['quilt', 'fabric']
        case 'neoforge':
            return build.minecraft === '1.20.1' ? ['neoforge', 'forge'] : ['neoforge']
        default:
            return [loader]
    }
}

export async function checkBuildHealth(build: Build, modversions?: ModversionWithMod[]): Promise<{ issues: Issue[]; checked: number }> {
    modversions ??= await modversionsForBuild(build.id)
    const repository = new ModRepository()
    const issues: Issue[] = []
    const jars: { modversion: string; jar: JarInfo }[] = []

    const loaders = modversions.filter((modversion) => LOADER_MODS.includes(modversion.mod.name))
    const loader = buildLoader(build, modversions)
    if (loader === null) {
        issues.push(issue('error', null, 'This build has no mod loader. Add Forge, NeoForge, Fabric or Quilt from Mods → Import → Mod loader.'))
    } else if (loaders.length > 1) {
        issues.push(issue('error', null, `This build has more than one mod loader: ${loaders.map((modversion) => modversion.mod.name).join(', ')}.`))
    }

    try {
        for (const modversion of modversions) {
            const label = modversion.mod.pretty_name || modversion.mod.name
            const cacheKey = `solder-jarinfo:v2:${modversion.id}:${modversion.md5}`
            const info = await Cache.rememberForever<{ error: string } | { jars: JarInfo[] }>(cacheKey, async () => {
                const copy = await repository.localCopy(modversion)
                return 'error' in copy ? { error: copy.error } : { jars: readModversion(copy.path) }
            })
            if ('error' in info) {
                await Cache.forget(cacheKey)
                issues.push(issue('error', label, `${modversion.version}: ${info.error}`))
                continue
            }
            for (const jar of info.jars) {
                jars.push({ modversion: label, jar })
            }
        }
    } finally {
        repository.cleanup()
    }

    // Everything the build provides, including jars bundled inside other jars
    const provided = new Set(BUILT_IN)
    const owners = new Map<string, string>()
    for (const { modversion: label, jar } of jars) {
        for (const id of jar.provides) {
            provided.add(id)
        }
        for (const mod of jar.mods) {
            const owner = owners.get(mod.id)
            if (owner !== undefined && owner !== label) {
                issues.push(issue('warning', label, `${mod.id} is included by both ${owner} and ${label}.`))
            }
            owners.set(mod.id, label)
        }
    }

    const compatible = compatibleLoaders(build, loader?.type ?? null)
    const minecraft = String(build.minecraft ?? '')
    for (const { modversion: label, jar } of jars) {
        if (compatible.length > 0 && jar.loaders.length > 0 && !jar.loaders.some((jarLoader) => compatible.includes(jarLoader))) {
            issues.push(issue('error', label, `${jar.file} is a ${jar.loaders.join('/')} mod, but this build uses ${loader?.type}.`))
            continue
        }
        for (const mod of jar.mods) {
            if (mod.minecraft !== '' && !satisfies(mod.minecraft, minecraft)) {
                issues.push(issue('warning', label, `${jar.file} is made for Minecraft ${mod.minecraft}, but this build is ${minecraft}.`))
            }
            for (const dependency of mod.depends) {
                if (!provided.has(dependency)) {
                    issues.push(issue('error', label, `${jar.file} requires "${dependency}", which isn't in this build.`))
                }
            }
        }
    }

    // Errors first, then by mod (PHP's spaceship operator on [severity, mod])
    issues.sort((a, b) => {
        const severity = (a.severity === 'error' ? 0 : 1) - (b.severity === 'error' ? 0 : 1)
        if (severity !== 0) {
            return severity
        }
        const modA = a.mod ?? ''
        const modB = b.mod ?? ''
        return modA < modB ? -1 : modA > modB ? 1 : 0
    })
    return { issues, checked: modversions.length }
}
