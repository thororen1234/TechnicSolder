import { Redis } from 'ioredis'
import { config } from '../config.js'

/**
 * A small key/value cache with expiry, like Laravel's Cache facade. Values are stored as JSON, in Redis when
 * CACHE_STORE=redis (shared by the web, worker and scheduler processes) or in memory otherwise.
 */
interface Store {
    get(key: string): Promise<string | null>
    set(key: string, value: string, seconds: number | null): Promise<void>
    delete(key: string): Promise<void>
    increment(key: string, seconds: number): Promise<number>
    flush(): Promise<void>
}

class MemoryStore implements Store {
    private entries = new Map<string, { value: string; expiresAt: number | null }>()

    async get(key: string): Promise<string | null> {
        const entry = this.entries.get(key)
        if (!entry) {
            return null
        }
        if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
            this.entries.delete(key)
            return null
        }
        return entry.value
    }

    async set(key: string, value: string, seconds: number | null): Promise<void> {
        this.entries.set(key, { value, expiresAt: seconds === null ? null : Date.now() + seconds * 1000 })
    }

    async delete(key: string): Promise<void> {
        this.entries.delete(key)
    }

    async increment(key: string, seconds: number): Promise<number> {
        const current = await this.get(key)
        const next = (current === null ? 0 : Number(current)) + 1
        const entry = this.entries.get(key)
        this.entries.set(key, { value: String(next), expiresAt: entry?.expiresAt ?? Date.now() + seconds * 1000 })
        return next
    }

    async flush(): Promise<void> {
        this.entries.clear()
    }
}

const PREFIX = 'solder_cache:'

class RedisStore implements Store {
    constructor(private redis: Redis) {}

    async get(key: string): Promise<string | null> {
        return this.redis.get(PREFIX + key)
    }

    async set(key: string, value: string, seconds: number | null): Promise<void> {
        if (seconds === null) {
            await this.redis.set(PREFIX + key, value)
        } else {
            await this.redis.set(PREFIX + key, value, 'EX', Math.max(1, Math.ceil(seconds)))
        }
    }

    async delete(key: string): Promise<void> {
        await this.redis.del(PREFIX + key)
    }

    async increment(key: string, seconds: number): Promise<number> {
        const [[, count]] = (await this.redis.multi().incr(PREFIX + key).expire(PREFIX + key, seconds, 'NX').exec()) as [
            [Error | null, number],
        ]
        return count
    }

    async flush(): Promise<void> {
        let cursor = '0'
        do {
            const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${PREFIX}*`, 'COUNT', 500)
            if (keys.length > 0) {
                await this.redis.del(...keys)
            }
            cursor = next
        } while (cursor !== '0')
    }
}

let redisConnection: Redis | null = null

/** The shared Redis connection (also used for sessions and the queue). */
export function redis(): Redis {
    redisConnection ??= new Redis({
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password,
        maxRetriesPerRequest: null,
        lazyConnect: false,
    })
    return redisConnection
}

export async function closeRedis(): Promise<void> {
    await redisConnection?.quit()
    redisConnection = null
}

let store: Store | null = null

function currentStore(): Store {
    store ??= config.cacheStore === 'redis' ? new RedisStore(redis()) : new MemoryStore()
    return store
}

/** Seconds until expiry, or null to keep forever */
type Ttl = number | null

export const Cache = {
    async get<T>(key: string, fallback: T | null = null): Promise<T | null> {
        const raw = await currentStore().get(key)
        return raw === null ? fallback : (JSON.parse(raw) as T)
    },

    async has(key: string): Promise<boolean> {
        return (await currentStore().get(key)) !== null
    },

    async put(key: string, value: unknown, seconds: Ttl): Promise<void> {
        await currentStore().set(key, JSON.stringify(value ?? null), seconds)
    },

    async forever(key: string, value: unknown): Promise<void> {
        await this.put(key, value, null)
    },

    async forget(...keys: string[]): Promise<void> {
        for (const key of keys) {
            await currentStore().delete(key)
        }
    },

    /** Get the cached value, or compute, store and return it. null and undefined results are not cached. */
    async remember<T>(key: string, seconds: Ttl, compute: () => Promise<T> | T): Promise<T> {
        const raw = await currentStore().get(key)
        if (raw !== null) {
            return JSON.parse(raw) as T
        }
        const value = await compute()
        if (value !== null && value !== undefined) {
            await currentStore().set(key, JSON.stringify(value), seconds)
        }
        return value
    },

    async rememberForever<T>(key: string, compute: () => Promise<T> | T): Promise<T> {
        return this.remember(key, null, compute)
    },

    /** Increment a counter that expires $seconds after it was first incremented */
    async increment(key: string, seconds: number): Promise<number> {
        return currentStore().increment(key, seconds)
    },

    async flush(): Promise<void> {
        await currentStore().flush()
    },

    /** Use a fresh in-memory store (tests) */
    useMemoryStore(): void {
        store = new MemoryStore()
    },
}

export const MINUTE = 60
export const HOUR = 3600
export const DAY = 86400
