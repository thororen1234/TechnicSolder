import { createHash } from 'node:crypto'
import { config } from '../config.js'
import { db } from '../database/prisma.js'
import { UploadedFile } from '../http/uploaded-file.js'
import { verifyPassword } from '../auth/passwords.js'

/**
 * A port of the parts of Laravel's validator Solder uses, with the same messages, so forms and the API report
 * problems exactly as before.
 */

export type Input = Record<string, unknown>

/** Field name => messages, like Laravel's MessageBag */
export type ErrorBag = Record<string, string[]>

interface UniqueRule {
    rule: 'unique'
    table: string
    column?: string
    ignoreId?: number | null
    where?: Record<string, unknown>
}

interface ExistsRule {
    rule: 'exists'
    table: string
    column?: string
}

interface EnumRule {
    rule: 'enum'
    values: readonly string[]
}

interface PasswordRule {
    rule: 'password'
    min: number
    uncompromised: boolean
}

interface CurrentPasswordRule {
    rule: 'current_password'
    hash: string | null
}

export type RuleObject = UniqueRule | ExistsRule | EnumRule | PasswordRule | CurrentPasswordRule
export type Rule = string | RuleObject
export type Rules = Record<string, string | Rule[]>

export const Rule = {
    unique(table: string, column?: string): UniqueRule & { ignore(id: number | null): UniqueRule; whereEquals(c: string, v: unknown): UniqueRule } {
        const rule: UniqueRule = { rule: 'unique', table, column }
        return Object.assign(rule, {
            ignore(id: number | null) {
                rule.ignoreId = id
                return rule
            },
            whereEquals(c: string, v: unknown) {
                rule.where = { ...(rule.where ?? {}), [c]: v }
                return rule
            },
        })
    },
    exists(table: string, column?: string): ExistsRule {
        return { rule: 'exists', table, column }
    },
    enum(values: readonly string[]): EnumRule {
        return { rule: 'enum', values }
    },
    /** Password::defaults(): at least 8 characters and not found in a data breach */
    password(): PasswordRule {
        return { rule: 'password', min: 8, uncompromised: true }
    },
    /** current_password: the signed-in user's password */
    currentPassword(hash: string | null): CurrentPasswordRule {
        return { rule: 'current_password', hash }
    },
}

const MESSAGES: Record<string, string> = {
    'accepted': 'The :attribute field must be accepted.',
    'alpha_dash': 'The :attribute field must only contain letters, numbers, dashes, and underscores.',
    'array': 'The :attribute field must be an array.',
    'boolean': 'The :attribute field must be true or false.',
    'confirmed': 'The :attribute field confirmation does not match.',
    'current_password': 'The password is incorrect.',
    'email': 'The :attribute field must be a valid email address.',
    'enum': 'The selected :attribute is invalid.',
    'exists': 'The selected :attribute is invalid.',
    'file': 'The :attribute field must be a file.',
    'in': 'The selected :attribute is invalid.',
    'integer': 'The :attribute field must be an integer.',
    'max.array': 'The :attribute field must not have more than :max items.',
    'max.file': 'The :attribute field must not be greater than :max kilobytes.',
    'max.numeric': 'The :attribute field must not be greater than :max.',
    'max.string': 'The :attribute field must not be greater than :max characters.',
    'min.array': 'The :attribute field must have at least :min items.',
    'min.file': 'The :attribute field must be at least :min kilobytes.',
    'min.numeric': 'The :attribute field must be at least :min.',
    'min.string': 'The :attribute field must be at least :min characters.',
    'numeric': 'The :attribute field must be a number.',
    'password.min': 'The :attribute field must be at least :min characters.',
    'password.uncompromised': 'The given :attribute has appeared in a data leak. Please choose a different :attribute.',
    'regex': 'The :attribute field format is invalid.',
    'required': 'The :attribute field is required.',
    'required_if': 'The :attribute field is required when :other is :value.',
    'required_if_accepted': 'The :attribute field is required when :other is accepted.',
    'same': 'The :attribute field must match :other.',
    'string': 'The :attribute field must be a string.',
    'unique': 'The :attribute has already been taken.',
    'url': 'The :attribute field must be a valid URL.',
}

const IMPLICIT = new Set(['required', 'required_if', 'required_if_accepted', 'accepted', 'present'])

interface ParsedRule {
    name: string
    parameters: string[]
    object?: RuleObject
}

function parseRule(rule: Rule): ParsedRule {
    if (typeof rule !== 'string') {
        return { name: rule.rule, parameters: [], object: rule }
    }
    const colon = rule.indexOf(':')
    if (colon === -1) {
        return { name: rule, parameters: [] }
    }
    const name = rule.slice(0, colon)
    const rest = rule.slice(colon + 1)
    // A regex may contain commas, so it is never split
    return { name, parameters: name === 'regex' ? [rest] : rest.split(',') }
}

function parseRules(rules: string | Rule[]): ParsedRule[] {
    const list = typeof rules === 'string' ? rules.split('|') : rules
    return list.map(parseRule)
}

/** Laravel's Arr::get with dot notation */
export function dataGet(data: unknown, key: string): unknown {
    let value: unknown = data
    for (const segment of key.split('.')) {
        if (value === null || typeof value !== 'object') {
            return undefined
        }
        value = (value as Record<string, unknown>)[segment]
    }
    return value
}

function hasKey(data: unknown, key: string): boolean {
    let value: unknown = data
    for (const segment of key.split('.')) {
        if (value === null || typeof value !== 'object' || !(segment in (value as object))) {
            return false
        }
        value = (value as Record<string, unknown>)[segment]
    }
    return true
}

/** Expand "files.*" into "files.0", "files.1"... for the values present */
function expandWildcards(data: Input, attribute: string): string[] {
    if (!attribute.includes('*')) {
        return [attribute]
    }
    const [head, ...tail] = attribute.split('.*')
    const parent = dataGet(data, head)
    if (parent === null || typeof parent !== 'object') {
        return []
    }
    const rest = tail.join('.*')
    return Object.keys(parent as object).flatMap((key) => expandWildcards(data, `${head}.${key}${rest}`))
}

function isEmpty(value: unknown): boolean {
    if (value === null || value === undefined) {
        return true
    }
    if (typeof value === 'string') {
        return value.trim() === ''
    }
    if (Array.isArray(value)) {
        return value.length === 0
    }
    if (value instanceof UploadedFile) {
        return value.size === 0 && !value.path
    }
    return false
}

const ACCEPTED = ['yes', 'on', '1', 1, true, 'true']

export function isNumeric(value: unknown): boolean {
    if (typeof value === 'number') {
        return Number.isFinite(value)
    }
    return typeof value === 'string' && /^\s*[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*$/i.test(value)
}

function isInteger(value: unknown): boolean {
    if (typeof value === 'number') {
        return Number.isInteger(value)
    }
    return typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())
}

/** Laravel's default attribute name: snake case with spaces */
function displayName(attribute: string, attributes: Record<string, string>): string {
    if (attributes[attribute]) {
        return attributes[attribute]
    }
    return attribute.replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase().replaceAll('_', ' ')
}

function size(value: unknown, numericRules: boolean): { kind: 'numeric' | 'string' | 'array' | 'file'; size: number } {
    if (value instanceof UploadedFile) {
        return { kind: 'file', size: value.size / 1024 }
    }
    if (Array.isArray(value)) {
        return { kind: 'array', size: value.length }
    }
    if (numericRules && isNumeric(value)) {
        return { kind: 'numeric', size: Number(value) }
    }
    return { kind: 'string', size: [...String(value ?? '')].length }
}

/** Convert a PHP regex like "/^\d+$/i" to a RegExp */
function phpRegex(pattern: string): RegExp {
    const match = /^(.)([\s\S]*)\1([a-zA-Z]*)$/.exec(pattern)
    if (!match) {
        return new RegExp(pattern)
    }
    return new RegExp(match[2], match[3].replace(/[^gimsuy]/g, '') + (match[3].includes('u') ? '' : 'u'))
}

function isUrl(value: string): boolean {
    if (!/^[a-z][a-z\d+.-]*:\/\/[^\s/?#]+[^\s]*$/i.test(value)) {
        return false
    }
    try {
        new URL(value)
        return true
    } catch {
        return false
    }
}

function isEmail(value: string): boolean {
    return /^[^\s@"(),:;<>[\\\]]+@[^\s@"(),:;<>[\\\]]+$/.test(value) && !value.includes('..')
}

const TABLE_MODELS: Record<string, string> = {
    modpacks: 'modpack',
    mods: 'mod',
    builds: 'build',
    clients: 'client',
    keys: 'key',
    users: 'user',
}

async function countRows(table: string, where: Record<string, unknown>, notId?: number | null): Promise<number> {
    const model = TABLE_MODELS[table]
    if (!model) {
        throw new Error(`Validation against the ${table} table is not supported`)
    }
    const delegate = (db as unknown as Record<string, { count(args: unknown): Promise<number> }>)[model]
    return delegate.count({
        where: { ...where, ...(notId !== undefined && notId !== null ? { NOT: { id: notId } } : {}) },
    })
}

/** Have I Been Pwned range lookup; a failed lookup lets the password through, as Laravel's does */
async function isCompromised(password: string): Promise<boolean> {
    if (!config.checkCompromisedPasswords) {
        return false
    }
    const hash = createHash('sha1').update(password).digest('hex').toUpperCase()
    try {
        const response = await fetch(`https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`, {
            headers: { 'Add-Padding': 'true' },
            signal: AbortSignal.timeout(30_000),
        })
        if (!response.ok) {
            return false
        }
        const suffix = hash.slice(5)
        return (await response.text()).split('\n').some((line) => {
            const [candidate, count] = line.trim().split(':')
            return candidate === suffix && Number(count) > 0
        })
    } catch {
        return false
    }
}

export interface ValidationResult {
    passes: boolean
    errors: ErrorBag
    /** The validated fields, like $validator->validated() */
    validated: Input
}

export async function validate(
    data: Input,
    rules: Rules,
    messages: Record<string, string> = {},
    attributes: Record<string, string> = {},
): Promise<ValidationResult> {
    const errors: ErrorBag = {}
    const validated: Input = {}

    for (const [pattern, ruleSet] of Object.entries(rules)) {
        const parsedRules = parseRules(ruleSet)
        const names = parsedRules.map((rule) => rule.name)
        const numericRules = names.includes('numeric') || names.includes('integer')
        const bail = names.includes('bail')

        for (const attribute of expandWildcards(data, pattern)) {
            if (names.includes('sometimes') && !hasKey(data, attribute)) {
                continue
            }
            const value = dataGet(data, attribute)
            if (names.includes('nullable') && (value === null || value === undefined)) {
                if (hasKey(data, attribute)) {
                    validated[attribute] = null
                }
                continue
            }
            let failedImplicit = false

            const fail = (rule: string, messageKey: string, replacements: Record<string, string> = {}) => {
                const custom = messages[`${pattern}.${rule}`] ?? messages[`${attribute}.${rule}`] ?? messages[rule]
                let message = custom ?? MESSAGES[messageKey] ?? `The :attribute field is invalid.`
                const replace: Record<string, string> = {
                    attribute: displayName(attribute, attributes),
                    input: typeof value === 'string' || typeof value === 'number' ? String(value) : '',
                    ...replacements,
                }
                for (const [key, replacement] of Object.entries(replace)) {
                    message = message.replaceAll(`:${key}`, replacement)
                }
                ;(errors[attribute] ??= []).push(message)
                if (IMPLICIT.has(rule)) {
                    failedImplicit = true
                }
            }

            for (const { name, parameters, object } of parsedRules) {
                if (['sometimes', 'nullable', 'bail'].includes(name)) {
                    continue
                }
                if (!IMPLICIT.has(name) && isEmpty(value) && !(value instanceof UploadedFile)) {
                    continue
                }
                await applyRule(name, parameters, object, value, data, attribute, attributes, numericRules, fail)
                if (failedImplicit || (bail && errors[attribute])) {
                    break
                }
            }

            if (!errors[attribute] && hasKey(data, attribute)) {
                validated[attribute] = value
            }
        }
    }

    return { passes: Object.keys(errors).length === 0, errors, validated }
}

async function applyRule(
    name: string,
    parameters: string[],
    object: RuleObject | undefined,
    value: unknown,
    data: Input,
    attribute: string,
    attributes: Record<string, string>,
    numericRules: boolean,
    fail: (rule: string, messageKey: string, replacements?: Record<string, string>) => void,
): Promise<void> {
    switch (name) {
        case 'required':
            if (isEmpty(value)) {
                fail('required', 'required')
            }
            return
        case 'required_if': {
            const [other, ...values] = parameters
            const otherValue = dataGet(data, other)
            if (values.map(String).includes(String(otherValue ?? '')) && isEmpty(value)) {
                fail('required_if', 'required_if', { other: displayName(other, attributes), value: values.join(', ') })
            }
            return
        }
        case 'required_if_accepted': {
            const [other] = parameters
            if (ACCEPTED.includes(dataGet(data, other) as string) && isEmpty(value)) {
                fail('required_if_accepted', 'required_if_accepted', { other: displayName(other, attributes) })
            }
            return
        }
        case 'accepted':
            if (!ACCEPTED.includes(value as string)) {
                fail('accepted', 'accepted')
            }
            return
        case 'string':
            if (typeof value !== 'string') {
                fail('string', 'string')
            }
            return
        case 'array':
            if (!Array.isArray(value) && (value === null || typeof value !== 'object' || value instanceof UploadedFile)) {
                fail('array', 'array')
            }
            return
        case 'boolean':
            if (![true, false, 0, 1, '0', '1'].includes(value as never)) {
                fail('boolean', 'boolean')
            }
            return
        case 'integer':
            if (!isInteger(value)) {
                fail('integer', 'integer')
            }
            return
        case 'numeric':
            if (!isNumeric(value)) {
                fail('numeric', 'numeric')
            }
            return
        case 'file':
            if (!(value instanceof UploadedFile)) {
                fail('file', 'file')
            }
            return
        case 'email':
            if (typeof value !== 'string' || !isEmail(value)) {
                fail('email', 'email')
            }
            return
        case 'url':
            if (typeof value !== 'string' || !isUrl(value)) {
                fail('url', 'url')
            }
            return
        case 'alpha_dash':
            if (!(typeof value === 'string' || typeof value === 'number') || !/^[\p{L}\p{M}\p{N}_-]+$/u.test(String(value))) {
                fail('alpha_dash', 'alpha_dash')
            }
            return
        case 'regex':
            if (!(typeof value === 'string' || typeof value === 'number') || !phpRegex(parameters[0]).test(String(value))) {
                fail('regex', 'regex')
            }
            return
        case 'in':
            if (Array.isArray(value) || !parameters.includes(String(value))) {
                fail('in', 'in')
            }
            return
        case 'max':
        case 'min': {
            const bound = Number(parameters[0])
            const measured = size(value, numericRules)
            if (name === 'max' ? measured.size > bound : measured.size < bound) {
                fail(name, `${name}.${measured.kind}`, { [name]: parameters[0] })
            }
            return
        }
        case 'same': {
            const [other] = parameters
            if (value !== dataGet(data, other)) {
                fail('same', 'same', { other: displayName(other, attributes) })
            }
            return
        }
        case 'confirmed':
            if (value !== dataGet(data, `${attribute}_confirmation`)) {
                fail('confirmed', 'confirmed')
            }
            return
        case 'unique': {
            const rule = object as UniqueRule | undefined
            const table = rule?.table ?? parameters[0]
            const column = rule?.column ?? parameters[1] ?? attribute
            const ignoreId = rule?.ignoreId ?? (parameters[2] !== undefined ? Number(parameters[2]) : undefined)
            const count = await countRows(table, { [column]: String(value), ...(rule?.where ?? {}) }, ignoreId)
            if (count > 0) {
                fail('unique', 'unique')
            }
            return
        }
        case 'exists': {
            const rule = object as ExistsRule | undefined
            const table = rule?.table ?? parameters[0]
            const column = rule?.column ?? parameters[1] ?? attribute
            const lookup = column === 'id' ? (isInteger(value) ? Number(value) : null) : String(value)
            if (lookup === null || (await countRows(table, { [column]: lookup })) === 0) {
                fail('exists', 'exists')
            }
            return
        }
        case 'enum':
            if (!(object as EnumRule).values.includes(String(value))) {
                fail('enum', 'enum')
            }
            return
        case 'password': {
            const rule = object as PasswordRule
            if (typeof value !== 'string') {
                fail('password', 'string')
            } else if ([...value].length < rule.min) {
                fail('password', 'password.min', { min: String(rule.min) })
            } else if (rule.uncompromised && (await isCompromised(value))) {
                fail('password', 'password.uncompromised')
            }
            return
        }
        case 'current_password': {
            const rule = object as CurrentPasswordRule
            if (typeof value !== 'string' || rule.hash === null || !(await verifyPassword(value, rule.hash))) {
                fail('current_password', 'current_password')
            }
            return
        }
        default:
            throw new Error(`Unknown validation rule "${name}"`)
    }
}

/** The first message of every field, in order (what errors->all() lists for single-message fields) */
export function allMessages(errors: ErrorBag): string[] {
    return Object.values(errors).flat()
}
