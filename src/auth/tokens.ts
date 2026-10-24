import { createHash, timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'
import { db } from '../database/prisma.js'
import type { PersonalAccessToken, User } from '../generated/prisma/postgresql/client.js'
import { random } from '../support/str.js'

/**
 * Personal access tokens, compatible with Laravel Sanctum: "{id}|{prefix}{40 random}{crc32b}", stored as the
 * SHA-256 of everything after the "|". Tokens created by the PHP version keep working.
 */
export const TOKENABLE_TYPE = 'App\\Models\\User'

function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex')
}

/** crc32b, as PHP's hash('crc32b') */
function crc32b(value: string): string {
    let crc = 0xffffffff
    for (const byte of Buffer.from(value)) {
        crc ^= byte
        for (let bit = 0; bit < 8; bit++) {
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
        }
    }
    return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')
}

export interface NewAccessToken {
    accessToken: PersonalAccessToken
    plainTextToken: string
}

export async function createToken(user: Pick<User, 'id'>, name: string): Promise<NewAccessToken> {
    const entropy = random(40)
    const plain = `${config.sanctum.tokenPrefix}${entropy}${crc32b(entropy)}`
    const expiration = config.sanctum.expiration
    const accessToken = await db.personalAccessToken.create({
        data: {
            tokenable_type: TOKENABLE_TYPE,
            tokenable_id: user.id,
            name,
            token: sha256(plain),
            abilities: JSON.stringify(['*']),
            expires_at: expiration ? new Date(Date.now() + expiration * 60_000) : null,
        },
    })
    return { accessToken, plainTextToken: `${accessToken.id}|${plain}` }
}

function hashesMatch(stored: string, candidate: string): boolean {
    const a = Buffer.from(stored)
    const b = Buffer.from(candidate)
    return a.length === b.length && timingSafeEqual(a, b)
}

/** The token for a bearer string, if it is valid and unexpired. Marks it as used. */
export async function findToken(bearer: string): Promise<PersonalAccessToken | null> {
    let token: PersonalAccessToken | null
    if (!bearer.includes('|')) {
        token = await db.personalAccessToken.findUnique({ where: { token: sha256(bearer) } })
    } else {
        const id = bearer.slice(0, bearer.indexOf('|'))
        const plain = bearer.slice(id.length + 1)
        token = /^\d+$/.test(id) ? await db.personalAccessToken.findUnique({ where: { id: Number(id) } }) : null
        if (token && !hashesMatch(token.token, sha256(plain))) {
            token = null
        }
    }
    if (!token || token.tokenable_type !== TOKENABLE_TYPE) {
        return null
    }
    const expiration = config.sanctum.expiration
    const created = token.created_at?.getTime() ?? 0
    if ((expiration && created + expiration * 60_000 <= Date.now()) || (token.expires_at && token.expires_at.getTime() <= Date.now())) {
        return null
    }
    await db.personalAccessToken.update({ where: { id: token.id }, data: { last_used_at: new Date() } })
    return token
}

export async function tokensFor(userId: number): Promise<PersonalAccessToken[]> {
    return db.personalAccessToken.findMany({
        where: { tokenable_type: TOKENABLE_TYPE, tokenable_id: userId },
        orderBy: { id: 'asc' },
    })
}

export async function deleteTokensFor(userId: number): Promise<void> {
    await db.personalAccessToken.deleteMany({ where: { tokenable_type: TOKENABLE_TYPE, tokenable_id: userId } })
}
