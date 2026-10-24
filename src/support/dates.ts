import { config } from '../config.js'

/**
 * Date helpers matching what Carbon printed, in the application timezone (APP_TIMEZONE).
 */

interface Parts {
    year: number
    month: number
    day: number
    hour: number
    minute: number
    second: number
    weekday: number
    offsetMinutes: number
}

function parts(date: Date): Parts {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: config.app.timezone,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        weekday: 'short',
        hourCycle: 'h23',
    })
    const values: Record<string, string> = {}
    for (const part of formatter.formatToParts(date)) {
        values[part.type] = part.value
    }
    const local = Date.UTC(+values.year, +values.month - 1, +values.day, +values.hour, +values.minute, +values.second)
    return {
        year: +values.year,
        month: +values.month,
        day: +values.day,
        hour: +values.hour,
        minute: +values.minute,
        second: +values.second,
        weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(values.weekday),
        offsetMinutes: Math.round((local - Math.floor(date.getTime() / 1000) * 1000) / 60_000),
    }
}

const pad = (value: number, length = 2) => String(value).padStart(length, '0')

export function toDate(value: Date | string | number | null | undefined): Date | null {
    if (value === null || value === undefined || value === '') {
        return null
    }
    if (value instanceof Date) {
        return value
    }
    // "Y-m-d H:i:s" strings from the database are in UTC
    const date = new Date(typeof value === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? `${value.replace(' ', 'T')}Z` : value)
    return Number.isNaN(date.getTime()) ? null : date
}

/** Y-m-d */
export function toDateString(date: Date): string {
    const p = parts(date)
    return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

function offset(minutes: number, separator = ':'): string {
    const sign = minutes < 0 ? '-' : '+'
    const absolute = Math.abs(minutes)
    return `${sign}${pad(Math.floor(absolute / 60))}${separator}${pad(absolute % 60)}`
}

/** Carbon's toIso8601String(): 2026-10-23T12:00:00+00:00 */
export function toIso8601String(date: Date = new Date()): string {
    const p = parts(date)
    return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${offset(p.offsetMinutes)}`
}

/** How Eloquent serialized dates to JSON: 2026-10-23T12:00:00.000000Z */
export function toJsonDate(value: Date | string | null | undefined): string | null {
    const date = toDate(value)
    if (date === null) {
        return null
    }
    return `${date.toISOString().slice(0, 19)}.${pad(date.getUTCMilliseconds(), 3)}000Z`
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** PHP date() formatting for the tokens Solder's views use */
export function formatDate(value: Date | string | null | undefined, format: string): string {
    const date = toDate(value)
    if (date === null) {
        return ''
    }
    const p = parts(date)
    let result = ''
    for (let i = 0; i < format.length; i++) {
        const token = format[i]
        switch (token) {
            case 'Y': result += p.year; break
            case 'y': result += pad(p.year % 100); break
            case 'm': result += pad(p.month); break
            case 'n': result += p.month; break
            case 'd': result += pad(p.day); break
            case 'j': result += p.day; break
            case 'H': result += pad(p.hour); break
            case 'G': result += p.hour; break
            case 'h': result += pad(p.hour % 12 || 12); break
            case 'g': result += p.hour % 12 || 12; break
            case 'i': result += pad(p.minute); break
            case 's': result += pad(p.second); break
            case 'A': result += p.hour < 12 ? 'AM' : 'PM'; break
            case 'a': result += p.hour < 12 ? 'am' : 'pm'; break
            case 'M': result += MONTHS[p.month - 1].slice(0, 3); break
            case 'F': result += MONTHS[p.month - 1]; break
            case 'D': result += DAYS[p.weekday].slice(0, 3); break
            case 'l': result += DAYS[p.weekday]; break
            case 'S': result += [1, 21, 31].includes(p.day) ? 'st' : [2, 22].includes(p.day) ? 'nd' : [3, 23].includes(p.day) ? 'rd' : 'th'; break
            case 'T': result += config.app.timezone === 'UTC' ? 'UTC' : offset(p.offsetMinutes, ''); break
            case 'P': result += offset(p.offsetMinutes); break
            case 'c': result += toIso8601String(date); break
            case 'O': result += offset(p.offsetMinutes, ''); break
            case 'r': result += formatDate(date, 'D, d M Y H:i:s O'); break
            case '\\': result += format[++i] ?? ''; break
            default: result += token
        }
    }
    return result
}

/** Carbon's diffForHumans(): "3 minutes ago", "in 2 days" */
export function diffForHumans(value: Date | string | null | undefined, now: Date = new Date()): string {
    const date = toDate(value)
    if (date === null) {
        return ''
    }
    const seconds = Math.round((now.getTime() - date.getTime()) / 1000)
    const absolute = Math.abs(seconds)
    const units: [string, number][] = [
        ['year', 365 * 86400],
        ['month', 30 * 86400],
        ['week', 7 * 86400],
        ['day', 86400],
        ['hour', 3600],
        ['minute', 60],
        ['second', 1],
    ]
    let label = '1 second'
    for (const [unit, length] of units) {
        if (absolute >= length) {
            const count = Math.floor(absolute / length)
            label = `${count} ${unit}${count === 1 ? '' : 's'}`
            break
        }
    }
    return seconds >= 0 ? `${label} ago` : `${label} from now`
}

export function subDays(days: number, from: Date = new Date()): Date {
    return new Date(from.getTime() - days * 86_400_000)
}
