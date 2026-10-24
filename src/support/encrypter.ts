import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'

/**
 * Laravel's Encrypter (AES-256-CBC with an HMAC), so values encrypted by the PHP version of Solder, such as
 * two-factor secrets, can still be read, and values written here can be read by it.
 *
 * Like Laravel's encrypt()/decrypt(), strings are PHP-serialized before encryption.
 */

interface Payload {
    iv: string
    value: string
    mac: string
    tag?: string
}

function key(): Buffer {
    const raw = config.app.key
    if (!raw) {
        throw new Error('No application encryption key has been specified. Set APP_KEY in your .env file.')
    }
    const decoded = raw.startsWith('base64:') ? Buffer.from(raw.slice(7), 'base64') : Buffer.from(raw, 'utf8')
    if (decoded.length !== 32) {
        throw new Error('APP_KEY must be a 32 byte key for AES-256-CBC.')
    }
    return decoded
}

function mac(iv: string, value: string, encryptionKey: Buffer): string {
    return createHmac('sha256', encryptionKey).update(iv + value).digest('hex')
}

/** PHP serialize() of a string */
function serializeString(value: string): string {
    return `s:${Buffer.byteLength(value, 'utf8')}:"${value}";`
}

/** PHP unserialize() of a string (the only type Solder encrypts) */
function unserializeString(value: string): string {
    const match = /^s:(\d+):"([\s\S]*)";$/.exec(value)
    if (!match) {
        throw new Error('The decrypted value is not a serialized string.')
    }
    return match[2]
}

export function encryptString(value: string, serialize = true): string {
    const encryptionKey = key()
    const iv = randomBytes(16)
    const cipher = createCipheriv('aes-256-cbc', encryptionKey, iv)
    const plaintext = serialize ? serializeString(value) : value
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64')
    const ivBase64 = iv.toString('base64')
    const payload: Payload = { iv: ivBase64, value: encrypted, mac: mac(ivBase64, encrypted, encryptionKey), tag: '' }
    return Buffer.from(JSON.stringify(payload)).toString('base64')
}

export function decryptString(payload: string, unserialize = true): string {
    const encryptionKey = key()
    let parsed: Payload
    try {
        parsed = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as Payload
    } catch {
        throw new Error('The payload is invalid.')
    }
    if (typeof parsed?.iv !== 'string' || typeof parsed.value !== 'string' || typeof parsed.mac !== 'string') {
        throw new Error('The payload is invalid.')
    }
    const expected = Buffer.from(mac(parsed.iv, parsed.value, encryptionKey))
    const actual = Buffer.from(parsed.mac)
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        throw new Error('The MAC is invalid.')
    }
    const decipher = createDecipheriv('aes-256-cbc', encryptionKey, Buffer.from(parsed.iv, 'base64'))
    const decrypted = Buffer.concat([decipher.update(Buffer.from(parsed.value, 'base64')), decipher.final()]).toString('utf8')
    return unserialize ? unserializeString(decrypted) : decrypted
}

/** A new APP_KEY value */
export function generateKey(): string {
    return `base64:${randomBytes(32).toString('base64')}`
}
