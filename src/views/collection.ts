import { naturalCompare } from '../support/str.js'

/**
 * An array with the Laravel Collection methods the views use ($mods->count(), ->pluck(), ->where()...), so
 * templates read much like the Blade views they were ported from.
 */
type Key<T> = keyof T | ((item: T) => unknown)

function valueOf<T>(item: T, key: Key<T> | string): unknown {
    if (typeof key === 'function') {
        return key(item)
    }
    let value: unknown = item
    for (const segment of String(key).split('.')) {
        value = value === null || value === undefined ? undefined : (value as Record<string, unknown>)[segment]
    }
    return value
}

function compare(a: unknown, b: unknown): number {
    if (a === b) {
        return 0
    }
    if (a === null || a === undefined) {
        return -1
    }
    if (b === null || b === undefined) {
        return 1
    }
    if (typeof a === 'number' && typeof b === 'number') {
        return a - b
    }
    if (a instanceof Date && b instanceof Date) {
        return a.getTime() - b.getTime()
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        for (let i = 0; i < Math.min(a.length, b.length); i++) {
            const result = compare(a[i], b[i])
            if (result !== 0) {
                return result
            }
        }
        return a.length - b.length
    }
    return String(a) < String(b) ? -1 : 1
}

export class Collection<T> extends Array<T> {
    static make<T>(items: Iterable<T> | ArrayLike<T> = []): Collection<T> {
        const collection = new Collection<T>()
        for (const item of Array.from(items)) {
            collection.push(item)
        }
        return collection
    }

    count(): number {
        return this.length
    }

    isEmpty(): boolean {
        return this.length === 0
    }

    isNotEmpty(): boolean {
        return this.length > 0
    }

    all(): T[] {
        return [...this]
    }

    toArray(): T[] {
        return [...this]
    }

    // @ts-expect-error Laravel's values() re-indexes the collection; for...of still uses Symbol.iterator
    override values(): Collection<T> {
        return Collection.make(this)
    }

    first(callback?: (item: T) => unknown): T | null {
        const found = callback ? this.find((item) => callback(item)) : this[0]
        return found ?? null
    }

    last(callback?: (item: T) => unknown): T | null {
        const items = callback ? this.filter((item) => callback(item)) : this
        return items.length > 0 ? items[items.length - 1] : null
    }

    take(count: number): Collection<T> {
        return Collection.make(count >= 0 ? this.slice(0, count) : this.slice(count))
    }

    pluck(value: string, key?: string): Collection<unknown> | Record<string, unknown> {
        if (key !== undefined) {
            return Object.fromEntries(this.map((item) => [String(valueOf(item, key)), valueOf(item, value)]))
        }
        return Collection.make(this.map((item) => valueOf(item, value)))
    }

    where(key: string, operatorOrValue: unknown, value?: unknown): Collection<T> {
        const [operator, expected] = value === undefined ? ['==', operatorOrValue] : [operatorOrValue as string, value]
        return Collection.make(
            this.filter((item) => {
                const actual = valueOf(item, key)
                switch (operator) {
                    case '!=':
                    case '<>':
                        // eslint-disable-next-line eqeqeq
                        return actual != expected
                    case '===':
                        return actual === expected
                    case '!==':
                        return actual !== expected
                    case '>':
                        return (actual as number) > (expected as number)
                    case '<':
                        return (actual as number) < (expected as number)
                    case '>=':
                        return (actual as number) >= (expected as number)
                    case '<=':
                        return (actual as number) <= (expected as number)
                    default:
                        // eslint-disable-next-line eqeqeq
                        return actual == expected
                }
            }),
        )
    }

    whereIn(key: string, values: unknown[]): Collection<T> {
        return Collection.make(this.filter((item) => values.includes(valueOf(item, key))))
    }

    firstWhere(key: string, operatorOrValue: unknown, value?: unknown): T | null {
        return this.where(key, operatorOrValue, value).first()
    }

    reject(callback: (item: T) => unknown): Collection<T> {
        return Collection.make(this.filter((item) => !callback(item)))
    }

    contains(value: unknown): boolean {
        return typeof value === 'function' ? this.some((item) => (value as (item: T) => unknown)(item)) : this.includes(value as T)
    }

    sortBy(key: Key<T>, natural = false): Collection<T> {
        return Collection.make(
            [...this].sort((a, b) =>
                natural ? naturalCompare(String(valueOf(a, key as string) ?? ''), String(valueOf(b, key as string) ?? '')) : compare(valueOf(a, key as string), valueOf(b, key as string)),
            ),
        )
    }

    sortByDesc(key: Key<T>): Collection<T> {
        return Collection.make([...this].sort((a, b) => compare(valueOf(b, key as string), valueOf(a, key as string))))
    }

    unique(key?: Key<T>): Collection<T> {
        const seen = new Set<unknown>()
        return Collection.make(
            this.filter((item) => {
                const value = key === undefined ? item : valueOf(item, key as string)
                if (seen.has(value)) {
                    return false
                }
                seen.add(value)
                return true
            }),
        )
    }

    sum(key?: Key<T>): number {
        return this.reduce((total, item) => total + Number(key === undefined ? item : valueOf(item, key as string)), 0)
    }

    max(key?: Key<T>): number | null {
        return this.length === 0 ? null : Math.max(...this.map((item) => Number(key === undefined ? item : valueOf(item, key as string))))
    }

    implode(keyOrGlue: string, glue?: string): string {
        if (glue === undefined) {
            return this.join(keyOrGlue)
        }
        return this.map((item) => valueOf(item, keyOrGlue)).join(glue)
    }

    keyBy(key: Key<T>): Record<string, T> {
        return Object.fromEntries(this.map((item) => [String(valueOf(item, key as string)), item]))
    }

    groupBy(key: Key<T>): Map<string, Collection<T>> {
        const groups = new Map<string, Collection<T>>()
        for (const item of this) {
            const group = String(valueOf(item, key as string))
            if (!groups.has(group)) {
                groups.set(group, new Collection<T>())
            }
            groups.get(group)!.push(item)
        }
        return groups
    }

    chunk(size: number): Collection<Collection<T>> {
        const chunks = new Collection<Collection<T>>()
        for (let i = 0; i < this.length; i += size) {
            chunks.push(Collection.make(this.slice(i, i + size)))
        }
        return chunks
    }
}

export function collect<T>(items: Iterable<T> | ArrayLike<T> | null | undefined = []): Collection<T> {
    return Collection.make(items ?? [])
}
