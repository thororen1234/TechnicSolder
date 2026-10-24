import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../config.js'
import { formatFilesize, humanFilesize } from '../models/modversion.js'
import { isFile } from '../support/files.js'
import { headline, limit, numberFormat, plural, slug, ucfirst } from '../support/str.js'
import { Carbon, carbon } from './carbon.js'
import { collect, Collection } from './collection.js'

/**
 * Functions available in every template, many named after the PHP functions the Blade views called so the
 * ported templates read the same.
 */

/** Laravel's MessageBag, as $errors in views */
export class ErrorBag {
    constructor(private readonly bag: Record<string, string[]> = {}) {}

    any(): boolean {
        return Object.keys(this.bag).length > 0
    }

    has(key: string): boolean {
        return (this.bag[key]?.length ?? 0) > 0
    }

    first(key?: string): string {
        if (key === undefined) {
            return this.all()[0] ?? ''
        }
        return this.bag[key]?.[0] ?? ''
    }

    get(key: string): string[] {
        return this.bag[key] ?? []
    }

    all(): Collection<string> {
        return collect(Object.values(this.bag).flat())
    }

    count(): number {
        return this.all().length
    }

    messages(): Record<string, string[]> {
        return this.bag
    }

    isEmpty(): boolean {
        return !this.any()
    }

    isNotEmpty(): boolean {
        return this.any()
    }
}

/**
 * Turn data for a view into what the templates expect: arrays become Collections and dates Carbon instances,
 * all the way down.
 */
export function toViewData(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
    if (value === null || value === undefined || typeof value !== 'object') {
        return value
    }
    if (value instanceof Carbon) {
        return value
    }
    if (value instanceof Date) {
        return new Carbon(value.getTime())
    }
    if (value instanceof ErrorBag || value instanceof Map || value instanceof Set || typeof (value as { then?: unknown }).then === 'function') {
        return value
    }
    if (seen.has(value)) {
        return seen.get(value)
    }
    if (Array.isArray(value)) {
        // Collection subclasses (Paginator) keep their type and extra methods
        if (value instanceof Collection && value.constructor !== Collection) {
            seen.set(value, value)
            for (let i = 0; i < value.length; i++) {
                value[i] = toViewData(value[i], seen)
            }
            return value
        }
        const collection = new Collection<unknown>()
        seen.set(value, collection)
        for (const item of value) {
            collection.push(toViewData(item, seen))
        }
        return collection
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
        // Class instances (ImportedModData...) keep their methods
        return value
    }
    const result: Record<string, unknown> = {}
    seen.set(value, result)
    for (const [key, item] of Object.entries(value)) {
        result[key] = toViewData(item, seen)
    }
    return result
}

/** Entries of an array, Map or object, for `foreach ($items as $key => $value)` */
export function entries(value: unknown): [string | number, unknown][] {
    if (value === null || value === undefined) {
        return []
    }
    if (value instanceof Map) {
        return [...value.entries()]
    }
    if (Array.isArray(value)) {
        return value.map((item, index) => [index, item])
    }
    return Object.entries(value as object)
}

const HEX_ESCAPES: Record<string, string> = { '<': '\\u003C', '>': '\\u003E', '&': '\\u0026', "'": '\\u0027', '\\"': '\\u0022', '/': '\\/' }

/** json_encode() with JSON_HEX_TAG | JSON_HEX_APOS | JSON_HEX_AMP | JSON_HEX_QUOT: no quote, tag or ampersand inside strings */
function hexJson(value: unknown): string {
    return (JSON.stringify(value ?? null) ?? 'null').replace(/\\.|[<>&'/]|[^\x00-\x7f]/g, (match) => {
        if (match in HEX_ESCAPES) {
            return HEX_ESCAPES[match]
        }
        if (match.length === 1) {
            return `\\u${match.charCodeAt(0).toString(16).padStart(4, '0')}`
        }
        return match
    })
}

/**
 * Js::from(): a JavaScript expression that is safe both in a <script> block and inside a double-quoted HTML
 * attribute (x-data="..."): strings become single-quoted literals, objects and arrays JSON.parse('...').
 */
export function js(value: unknown): string {
    if (typeof value === 'string') {
        return `'${hexJson(value).slice(1, -1)}'`
    }
    const encoded = hexJson(value)
    if (encoded === '[]' || encoded === '{}') {
        return encoded
    }
    if (/^["{[]/.test(encoded)) {
        return `JSON.parse('${hexJson(encoded).slice(1, -1)}')`
    }
    return encoded
}

/** @json(): JSON for a <script> block */
export function json(value: unknown): string {
    return (JSON.stringify(value ?? null) ?? 'null').replace(/</g, '\\u003C').replace(/>/g, '\\u003E').replace(/&/g, '\\u0026')
}

/** @class([...]): class names whose condition is true */
export function classes(list: Record<string, unknown> | (string | Record<string, unknown>)[]): string {
    const items = Array.isArray(list) ? list : [list]
    const names: string[] = []
    for (const item of items) {
        if (typeof item === 'string') {
            names.push(item)
        } else {
            for (const [name, condition] of Object.entries(item)) {
                if (/^\d+$/.test(name)) {
                    names.push(String(condition))
                } else if (condition) {
                    names.push(name)
                }
            }
        }
    }
    return names.filter(Boolean).join(' ')
}

function escapeAttribute(value: unknown): string {
    return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * A component's leftover attributes as HTML, merging classes like $attributes->class() / ->merge()
 */
export function attributes(bag: Record<string, unknown> | undefined, defaults: { class?: string } & Record<string, unknown> = {}, except: string[] = []): string {
    const merged: Record<string, unknown> = { ...defaults }
    for (const [name, value] of Object.entries(bag ?? {})) {
        if (except.includes(name)) {
            continue
        }
        merged[name] = name === 'class' && defaults.class ? `${defaults.class} ${value}` : value
    }
    return Object.entries(merged)
        .filter(([, value]) => value !== false && value !== null && value !== undefined)
        .map(([name, value]) => (value === true ? name : `${name}="${escapeAttribute(value)}"`))
        .join(' ')
}

interface ViteManifestEntry {
    file: string
    css?: string[]
    isEntry?: boolean
}

let manifest: Record<string, ViteManifestEntry> | null = null

/** @vite(): script and stylesheet tags for the entry points, from the dev server or the build manifest */
export function vite(entrypoints: string[]): string {
    const hotFile = join(config.paths.public, 'hot')
    if (existsSync(hotFile)) {
        const server = readFileSync(hotFile, 'utf8').trim().replace(/\/+$/, '')
        return [
            `<script type="module" src="${server}/@vite/client"></script>`,
            ...entrypoints.map((entry) =>
                entry.endsWith('.css') ? `<link rel="stylesheet" href="${server}/${entry}">` : `<script type="module" src="${server}/${entry}"></script>`,
            ),
        ].join('\n')
    }
    if (manifest === null || config.app.env !== 'production') {
        const path = join(config.paths.public, 'build/manifest.json')
        if (!existsSync(path)) {
            if (config.app.env === 'testing') {
                return ''
            }
            throw new Error('Vite manifest not found at public/build/manifest.json. Run "pnpm run build".')
        }
        manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, ViteManifestEntry>
    }
    const tags: string[] = []
    for (const entry of entrypoints) {
        const chunk = manifest[entry]
        if (!chunk) {
            throw new Error(`Unable to locate file in Vite manifest: ${entry}.`)
        }
        for (const css of chunk.css ?? []) {
            tags.push(`<link rel="stylesheet" href="/build/${css}">`)
        }
        tags.push(chunk.file.endsWith('.css') ? `<link rel="stylesheet" href="/build/${chunk.file}">` : `<script type="module" src="/build/${chunk.file}"></script>`)
    }
    return tags.join('\n')
}

/** @fonts: the Inter font from Bunny Fonts */
export function fonts(): string {
    return [
        '<link rel="preconnect" href="https://fonts.bunny.net">',
        '<link href="https://fonts.bunny.net/css?family=inter:400,500,600,700&display=swap" rel="stylesheet">',
    ].join('\n')
}

/** PHP functions the templates call */
export const php = {
    count: (value: unknown) => (value === null || value === undefined ? 0 : Array.isArray(value) ? value.length : value instanceof Map ? value.size : typeof value === 'object' ? Object.keys(value as object).length : 1),
    empty: (value: unknown) =>
        value === null ||
        value === undefined ||
        value === false ||
        value === 0 ||
        value === '' ||
        value === '0' ||
        (Array.isArray(value) && value.length === 0) ||
        (value instanceof Map && value.size === 0) ||
        (typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Map) && !(value instanceof Date) && Object.keys(value).length === 0),
    strtoupper: (value: unknown) => String(value ?? '').toUpperCase(),
    strtolower: (value: unknown) => String(value ?? '').toLowerCase(),
    mb_strtoupper: (value: unknown) => String(value ?? '').toUpperCase(),
    ucfirst: (value: unknown) => ucfirst(String(value ?? '')),
    substr: (value: unknown, start: number, length?: number) => {
        const text = String(value ?? '')
        const from = start < 0 ? Math.max(0, text.length + start) : start
        return length === undefined ? text.slice(from) : text.slice(from, length < 0 ? text.length + length : from + length)
    },
    mb_substr: (value: unknown, start: number, length?: number) => {
        const chars = [...String(value ?? '')]
        return (length === undefined ? chars.slice(start) : chars.slice(start, start + length)).join('')
    },
    trim: (value: unknown) => String(value ?? '').trim(),
    number_format: (value: unknown, decimals = 0) => numberFormat(Number(value ?? 0), decimals),
    in_array: (needle: unknown, haystack: unknown) => (Array.isArray(haystack) ? haystack.map(String).includes(String(needle)) : false),
    array_key_exists: (key: string, value: unknown) => value !== null && typeof value === 'object' && key in (value as object),
    is_array: (value: unknown) => Array.isArray(value) || (value !== null && typeof value === 'object' && !(value instanceof Date)),
    is_string: (value: unknown) => typeof value === 'string',
    implode: (glue: string, items: unknown) => (Array.isArray(items) ? items.join(glue) : ''),
    json_encode: (value: unknown) => JSON.stringify(value),
    str_contains: (haystack: unknown, needle: string) => String(haystack ?? '').includes(needle),
    str_starts_with: (haystack: unknown, needle: string) => String(haystack ?? '').startsWith(needle),
    round: (value: number, precision = 0) => Math.round(value * 10 ** precision) / 10 ** precision,
    intval: (value: unknown) => Number.parseInt(String(value ?? 0), 10) || 0,
    max: Math.max,
    min: Math.min,
    ceil: Math.ceil,
    floor: Math.floor,
    array_keys: (value: unknown) => collect(value instanceof Map ? [...value.keys()] : Object.keys(value ?? {})),
    array_values: (value: unknown) => collect(value instanceof Map ? [...value.values()] : Object.values(value ?? {})),
    is_file: (path: string) => isFile(path),
    array_sum: (value: unknown) => Object.values(value ?? {}).reduce((total: number, item) => total + Number(item ?? 0), 0),
    /** array_filter() without a callback: drops null, '', 0, '0' and false */
    array_filter: (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([, item]) => !(item === null || item === undefined || item === '' || item === 0 || item === '0' || item === false))),
    http_build_query: (value: Record<string, unknown>) => new URLSearchParams(Object.entries(value).map(([key, item]) => [key, String(item ?? '')])).toString(),
    base64_encode: (value: unknown) => Buffer.from(String(value)).toString('base64'),
    date_create: (value: unknown) => carbon(value as string),
    date_format: (date: Carbon | null, format: string) => (date ? date.format(format) : ''),
    nl2br: (value: string) => String(value ?? '').replace(/\r?\n/g, '<br />\n'),
    plural,
    limit,
    headline,
    slug,
    formatFilesize,
    humanFilesize,
    collect,
    entries,
    js,
    json,
    classes,
    attributes,
    fonts,
    vite,
}
