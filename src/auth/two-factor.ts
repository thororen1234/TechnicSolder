import { createHash, createHmac, randomBytes } from 'node:crypto'
import QRCode from 'qrcode'
import { config } from '../config.js'
import { db } from '../database/prisma.js'
import type { User } from '../generated/prisma/postgresql/client.js'
import { Cache } from '../support/cache.js'
import { decryptString, encryptString } from '../support/encrypter.js'
import { random } from '../support/str.js'

/**
 * Time-based one-time passwords, compatible with Laravel Fortify (Google2FA): base32 secrets encrypted with
 * APP_KEY, 6 digit codes every 30 seconds accepted one step either side, and each code usable only once.
 */
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const WINDOW = 1
const PERIOD = 30

export function generateSecret(length = 16): string {
    return [...randomBytes(length)].map((byte) => BASE32[byte % 32]).join('')
}

function base32Decode(secret: string): Buffer {
    const clean = secret.toUpperCase().replace(/[^A-Z2-7]/g, '')
    let bits = ''
    for (const char of clean) {
        bits += BASE32.indexOf(char).toString(2).padStart(5, '0')
    }
    const bytes: number[] = []
    for (let i = 0; i + 8 <= bits.length; i += 8) {
        bytes.push(Number.parseInt(bits.slice(i, i + 8), 2))
    }
    return Buffer.from(bytes)
}

export function codeAt(secret: string, timestep: number): string {
    const counter = Buffer.alloc(8)
    counter.writeBigUInt64BE(BigInt(timestep))
    const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest()
    const offset = hmac[hmac.length - 1] & 0x0f
    const binary = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000
    return String(binary).padStart(6, '0')
}

function currentTimestep(): number {
    return Math.floor(Date.now() / 1000 / PERIOD)
}

/** Whether the code is valid for the secret and hasn't been used before */
export async function verifyCode(secret: string, code: string): Promise<boolean> {
    const cleaned = code.replace(/\s+/g, '')
    if (!/^\d{6}$/.test(cleaned)) {
        return false
    }
    const cacheKey = `fortify.2fa_codes.${createHash('md5').update(cleaned).digest('hex')}`
    const lastUsed = await Cache.get<number>(cacheKey)
    const now = currentTimestep()
    for (let step = now - WINDOW; step <= now + WINDOW; step++) {
        if (codeAt(secret, step) === cleaned && (lastUsed === null || step > lastUsed)) {
            await Cache.put(cacheKey, step, Math.max(WINDOW, 1) * 60)
            return true
        }
    }
    return false
}

export function decryptSecret(user: Pick<User, 'two_factor_secret'>): string | null {
    return user.two_factor_secret ? decryptString(user.two_factor_secret) : null
}

export function recoveryCodes(user: Pick<User, 'two_factor_recovery_codes'>): string[] {
    if (!user.two_factor_recovery_codes) {
        return []
    }
    return JSON.parse(decryptString(user.two_factor_recovery_codes)) as string[]
}

function generateRecoveryCodes(): string[] {
    return Array.from({ length: 8 }, () => `${random(10)}-${random(10)}`)
}

export function hasEnabledTwoFactor(user: Pick<User, 'two_factor_secret' | 'two_factor_confirmed_at'>): boolean {
    return user.two_factor_secret !== null && user.two_factor_confirmed_at !== null
}

/** Start setting up two-factor authentication (not active until confirmed with a code) */
export async function enableTwoFactor(userId: number, force = false): Promise<void> {
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } })
    if (user.two_factor_secret !== null && !force) {
        return
    }
    await db.user.update({
        where: { id: userId },
        data: {
            two_factor_secret: encryptString(generateSecret()),
            two_factor_recovery_codes: encryptString(JSON.stringify(generateRecoveryCodes())),
            two_factor_confirmed_at: null,
        },
    })
}

export async function confirmTwoFactor(userId: number, code: string): Promise<boolean> {
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } })
    const secret = decryptSecret(user)
    if (secret === null || !(await verifyCode(secret, code))) {
        return false
    }
    await db.user.update({ where: { id: userId }, data: { two_factor_confirmed_at: new Date() } })
    return true
}

export async function disableTwoFactor(userId: number): Promise<void> {
    await db.user.update({
        where: { id: userId },
        data: { two_factor_secret: null, two_factor_recovery_codes: null, two_factor_confirmed_at: null },
    })
}

export async function regenerateRecoveryCodes(userId: number): Promise<void> {
    await db.user.update({
        where: { id: userId },
        data: { two_factor_recovery_codes: encryptString(JSON.stringify(generateRecoveryCodes())) },
    })
}

/** Use up a recovery code, replacing it with a new one, as Fortify does. Returns whether it was valid. */
export async function useRecoveryCode(user: User, code: string): Promise<boolean> {
    const codes = recoveryCodes(user)
    const index = codes.indexOf(code.trim())
    if (index === -1) {
        return false
    }
    codes[index] = `${random(10)}-${random(10)}`
    await db.user.update({
        where: { id: user.id },
        data: { two_factor_recovery_codes: encryptString(JSON.stringify(codes)) },
    })
    return true
}

/** The otpauth:// URL, with the instance's host in the issuer so several Solders can be told apart */
export function qrCodeUrl(user: Pick<User, 'email' | 'two_factor_secret'>): string {
    let host = config.app.url
    try {
        host = new URL(config.app.url).hostname || config.app.url
    } catch {
        // Not a URL: use it as it is
    }
    const company = encodeURIComponent(`${config.app.name} (${host})`)
    return `otpauth://totp/${company}:${encodeURIComponent(user.email)}?secret=${decryptSecret(user)}&issuer=${company}&algorithm=SHA1&digits=6&period=30`
}

export async function qrCodeSvg(user: Pick<User, 'email' | 'two_factor_secret'>): Promise<string> {
    return QRCode.toString(qrCodeUrl(user), { type: 'svg', width: 192, margin: 0, color: { dark: '#2d3748', light: '#ffffff' } })
}
