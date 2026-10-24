import type { Request, Response } from 'express'
import { Web } from '../http/web.js'
import { validate, type Rules } from '../support/validation.js'

export function api(req: Request, res: Response): Web {
    return Web.of(req, res)
}

/** Validate API input; on failure send `{"error": {field: [messages]}}` with 422 and return false */
export async function apiValidate(web: Web, rules: Rules, data: Record<string, unknown> = web.all()): Promise<boolean> {
    const result = await validate(data, rules)
    if (!result.passes) {
        web.json({ error: result.errors }, 422)
        return false
    }
    return true
}

/** $request->only([...]): the keys present in the input */
export function only(web: Web, keys: readonly string[]): Record<string, unknown> {
    const input = web.all()
    return Object.fromEntries(keys.filter((key) => key in input).map((key) => [key, input[key]]))
}

/** Booleans from API input ("1", "true", 1, true) as the database expects them */
export function toBoolean(value: unknown): boolean {
    return value === true || value === 1 || ['1', 'true', 'on', 'yes'].includes(String(value).toLowerCase())
}

const BOOLEAN_COLUMNS = ['hidden', 'private', 'is_published']
const INTEGER_COLUMNS = ['order', 'min_memory', 'filesize']

/** Cast API input to the column types (Eloquent did this when saving) */
export function castColumns(data: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(data)) {
        if (BOOLEAN_COLUMNS.includes(key)) {
            result[key] = value === null ? false : toBoolean(value)
        } else if (INTEGER_COLUMNS.includes(key)) {
            result[key] = value === null || value === '' ? null : Number.parseInt(String(value), 10)
        } else {
            result[key] = value === null || value === undefined ? null : typeof value === 'object' ? JSON.stringify(value) : String(value)
        }
    }
    return result
}
