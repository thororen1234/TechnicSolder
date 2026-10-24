import bcrypt from 'bcryptjs'
import { config } from '../config.js'

/**
 * Passwords are bcrypt hashes, as Laravel stored them. PHP writes the "$2y$" prefix, which is the same
 * algorithm as "$2b$"; hashes written here use "$2y$" too so the PHP version can still read them.
 */
export async function hashPassword(password: string): Promise<string> {
    const hash = await bcrypt.hash(password, config.app.bcryptRounds)
    return hash.replace(/^\$2[ab]\$/, '$2y$')
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
    if (!hash || !/^\$2[aby]\$/.test(hash)) {
        return false
    }
    return bcrypt.compare(password, hash.replace(/^\$2y\$/, '$2b$'))
}

/** Whether a hash was made with a different work factor than BCRYPT_ROUNDS */
export function needsRehash(hash: string): boolean {
    const match = /^\$2[aby]\$(\d{2})\$/.exec(hash)
    return match === null || Number(match[1]) !== config.app.bcryptRounds
}
