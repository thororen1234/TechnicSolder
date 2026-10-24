import { toJsonDate } from '../support/dates.js'

/** Attributes Eloquent kept out of a user's JSON */
const USER_HIDDEN = ['password', 'remember_token', 'two_factor_secret', 'two_factor_recovery_codes']

/**
 * A row as Eloquent serialized it to JSON: dates as "2026-10-23T12:00:00.000000Z", hidden attributes left out.
 */
export function serialize<T extends object>(row: T, hidden: string[] = []): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(row)) {
        if (hidden.includes(key)) {
            continue
        }
        if (value instanceof Date) {
            result[key] = toJsonDate(value)
        } else if (Array.isArray(value)) {
            result[key] = value.map((item) => (item !== null && typeof item === 'object' && !(item instanceof Date) ? serialize(item) : item))
        } else if (value !== null && typeof value === 'object') {
            result[key] = serialize(value)
        } else if (typeof value === 'bigint') {
            result[key] = Number(value)
        } else {
            result[key] = value
        }
    }
    return result
}

export function serializeUser<T extends object>(user: T): Record<string, unknown> {
    return serialize(user, USER_HIDDEN)
}

/** $model->only([...]) */
export function only<T extends object, K extends keyof T>(row: T, keys: readonly K[]): Pick<T, K> {
    const result = {} as Pick<T, K>
    for (const key of keys) {
        result[key] = row[key]
    }
    return result
}
