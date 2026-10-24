import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'
import { config } from '../config.js'

/**
 * Laravel's "local" disk (storage/app/private): imports waiting for a decision and finished exports.
 */
export function localPath(relativePath: string): string {
    const full = normalize(join(config.paths.storage, relativePath))
    if (relative(config.paths.storage, full).startsWith('..')) {
        throw new Error(`${relativePath} is outside the storage directory`)
    }
    return full
}

export function localExists(relativePath: string): boolean {
    return existsSync(localPath(relativePath))
}

export function makeLocalDirectory(relativePath: string): string {
    const full = localPath(relativePath)
    mkdirSync(full, { recursive: true })
    return full
}

export function ensureParentDirectory(path: string): void {
    mkdirSync(dirname(path), { recursive: true })
}

export function deleteLocal(relativePath: string): void {
    rmSync(localPath(relativePath), { force: true })
}

/** Files directly inside a directory of the disk, as relative paths */
export function localFiles(relativeDirectory: string): string[] {
    const full = localPath(relativeDirectory)
    if (!existsSync(full)) {
        return []
    }
    return readdirSync(full)
        .filter((name) => statSync(join(full, name)).isFile())
        .map((name) => `${relativeDirectory}/${name}`)
}

export function lastModified(relativePath: string): number {
    return statSync(localPath(relativePath)).mtimeMs
}
