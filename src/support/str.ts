import { randomBytes, randomUUID } from 'node:crypto'

/**
 * Ports of the Laravel Str helpers Solder relies on, with the same output.
 */

/** Letters with no decomposition that Str::ascii still folds to plain ASCII */
const ASCII_FOLDS: Record<string, string> = { ı: 'i', İ: 'I', ł: 'l', Ł: 'L', ø: 'o', Ø: 'O', đ: 'd', Đ: 'D', ß: 'ss', æ: 'ae', Æ: 'AE', œ: 'oe', Œ: 'OE', þ: 'th', Þ: 'TH' }

/** Str::ascii, approximately: strip accents so "Café" becomes "Cafe" */
export function ascii(value: string): string {
    return value
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .replace(/[ıİłŁøØđĐßæÆœŒþÞ]/g, (char) => ASCII_FOLDS[char] ?? char)
}

/** Str::slug: lowercase words joined by dashes, "@" spelled out */
export function slug(value: string | null | undefined, separator = '-'): string {
    let title = ascii(String(value ?? ''))
    const flip = separator === '-' ? '_' : '-'
    title = title.split(flip).join(separator)
    title = title.replaceAll('@', `${separator}at${separator}`)
    title = title.toLowerCase().replace(new RegExp(`[^${escapeRegExp(separator)}\\p{L}\\p{N}\\s]+`, 'gu'), '')
    title = title.replace(new RegExp(`[${escapeRegExp(separator)}\\s]+`, 'gu'), separator)
    return title.replace(new RegExp(`^${escapeRegExp(separator)}+|${escapeRegExp(separator)}+$`, 'g'), '')
}

export function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')
}

const IRREGULAR_PLURALS: Record<string, string> = {
    child: 'children',
    person: 'people',
}

/** Str::plural for the English words Solder uses */
export function plural(word: string, count: number | unknown[] = 2): string {
    const n = Array.isArray(count) ? count.length : count
    if (Math.abs(n) === 1) {
        return word
    }
    const lower = word.toLowerCase()
    let result: string
    if (IRREGULAR_PLURALS[lower]) {
        result = IRREGULAR_PLURALS[lower]
    } else if (/[^aeiou]y$/i.test(word)) {
        result = word.slice(0, -1) + 'ies'
    } else if (/(s|x|z|ch|sh)$/i.test(word)) {
        result = word + 'es'
    } else {
        result = word + 's'
    }
    return word === word.toUpperCase() && word.length > 1 ? result.toUpperCase() : matchCase(result, word)
}

function matchCase(value: string, comparison: string): string {
    return comparison[0] === comparison[0]?.toUpperCase() ? value[0].toUpperCase() + value.slice(1) : value
}

/** Str::limit: truncate to $limit characters, appending "..." */
export function limit(value: string | null | undefined, max = 100, end = '...'): string {
    const text = String(value ?? '')
    const chars = [...text]
    if (chars.length <= max) {
        return text
    }
    return chars.slice(0, max).join('').trimEnd() + end
}

/** Str::headline: "some_mod-name" becomes "Some Mod Name" */
export function headline(value: string): string {
    const parts = value
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .split(/[\s_-]+/)
        .filter(Boolean)
    return parts.map((part) => part[0].toUpperCase() + part.slice(1)).join(' ')
}

/** ucfirst */
export function ucfirst(value: string): string {
    return value ? value[0].toUpperCase() + value.slice(1) : value
}

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** Str::random: cryptographically random alphanumeric string */
export function random(length = 16): string {
    let result = ''
    while (result.length < length) {
        for (const byte of randomBytes(length * 2)) {
            // 248 is the largest multiple of 62 below 256, so the distribution stays uniform
            if (byte < 248 && result.length < length) {
                result += ALPHANUMERIC[byte % 62]
            }
        }
    }
    return result
}

export function uuid(): string {
    return randomUUID()
}

export function isUuid(value: string): boolean {
    return /^[\da-fA-F]{8}-[\da-fA-F]{4}-[\da-fA-F]{4}-[\da-fA-F]{4}-[\da-fA-F]{12}$/.test(value)
}

/** strnatcasecmp: natural, case-insensitive comparison ("mod2" before "mod10") */
export function naturalCompare(a: string, b: string): number {
    return naturalCollator.compare(a, b)
}

const naturalCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

/** PHP's number_format with the default separators */
export function numberFormat(value: number, decimals = 0): string {
    return value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

/** basename() for paths with either slash */
export function basename(path: string): string {
    const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
    return parts[parts.length - 1] ?? ''
}

/** pathinfo($path, PATHINFO_FILENAME) */
export function filenameWithoutExtension(path: string): string {
    const name = basename(path)
    const dot = name.lastIndexOf('.')
    return dot > 0 ? name.slice(0, dot) : name
}

/** pathinfo($path, PATHINFO_EXTENSION) */
export function extension(path: string): string {
    const name = basename(path)
    const dot = name.lastIndexOf('.')
    return dot > 0 ? name.slice(dot + 1) : ''
}

/** Str::transliterate + lower, approximately, for throttle keys */
export function transliterateLower(value: string): string {
    return ascii(value).toLowerCase()
}
