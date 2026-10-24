import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, existsSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** md5_file() / sha1_file() */
export async function hashFile(path: string, algorithm: 'md5' | 'sha1' | 'sha512' = 'md5'): Promise<string> {
    const hash = createHash(algorithm)
    for await (const chunk of createReadStream(path)) {
        hash.update(chunk as Buffer)
    }
    return hash.digest('hex')
}

export function hashBuffer(contents: Buffer | string, algorithm: 'md5' | 'sha1' | 'sha512' = 'md5'): string {
    return createHash(algorithm).update(contents).digest('hex')
}

/** tempnam(): an empty temporary file */
export function tempFile(prefix = 'solder_'): string {
    const path = join(tmpdir(), `${prefix}${randomBytes(8).toString('hex')}`)
    writeFileSync(path, '')
    return path
}

export function removeFile(path: string | null | undefined): void {
    if (path && existsSync(path)) {
        rmSync(path, { force: true })
    }
}

export function fileSize(path: string): number {
    try {
        return statSync(path).size
    } catch {
        return 0
    }
}

export function isFile(path: string): boolean {
    try {
        return statSync(path).isFile()
    } catch {
        return false
    }
}

/** filter_var($value, FILTER_VALIDATE_URL), approximately */
export function isUrl(value: string): boolean {
    if (!/^[a-z][a-z\d+.-]*:\/\/\S+$/i.test(value)) {
        return false
    }
    try {
        return Boolean(new URL(value).host)
    } catch {
        return false
    }
}
