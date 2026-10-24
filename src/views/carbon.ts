import { diffForHumans, formatDate, toDateString, toIso8601String } from '../support/dates.js'

/**
 * A Date with the Carbon methods the views use ($log->created_at->diffForHumans()...).
 */
export class Carbon extends Date {
    diffForHumans(): string {
        return diffForHumans(this)
    }

    format(format: string): string {
        return formatDate(this, format)
    }

    toIso8601String(): string {
        return toIso8601String(this)
    }

    override toDateString(): string {
        return toDateString(this)
    }

    toDateTimeString(): string {
        return formatDate(this, 'Y-m-d H:i:s')
    }

    get timestamp(): number {
        return Math.floor(this.getTime() / 1000)
    }

    isPast(): boolean {
        return this.getTime() < Date.now()
    }

    /** How Blade printed a Carbon: "2026-10-23 12:00:00" */
    override toString(): string {
        return this.toDateTimeString()
    }
}

export function carbon(value: Date | string | number | null | undefined): Carbon | null {
    if (value === null || value === undefined || value === '') {
        return null
    }
    const date = new Carbon(value instanceof Date ? value.getTime() : value)
    return Number.isNaN(date.getTime()) ? null : date
}
