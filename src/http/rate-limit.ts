import { Cache } from '../support/cache.js'
import { TooManyRequestsError } from './errors.js'

/**
 * Fixed-window rate limiting, like Laravel's RateLimiter: at most `max` attempts per `decaySeconds` for a key.
 */
export async function hit(key: string, max: number, decaySeconds = 60): Promise<{ allowed: boolean; remaining: number; retryAfter: number }> {
    const cacheKey = `rate-limit:${key}`
    const timerKey = `${cacheKey}:timer`
    let resetAt = await Cache.get<number>(timerKey)
    if (resetAt === null || resetAt <= Date.now()) {
        resetAt = Date.now() + decaySeconds * 1000
        await Cache.put(timerKey, resetAt, decaySeconds)
        await Cache.forget(cacheKey)
    }
    const attempts = await Cache.increment(cacheKey, decaySeconds)
    return {
        allowed: attempts <= max,
        remaining: Math.max(0, max - attempts),
        retryAfter: Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)),
    }
}

/** Throw a 429 when the key has used up its attempts */
export async function throttle(key: string, max: number, decaySeconds = 60): Promise<void> {
    const result = await hit(key, max, decaySeconds)
    if (!result.allowed) {
        throw new TooManyRequestsError(result.retryAfter)
    }
}

/** Seconds until the key can try again, without counting an attempt; 0 when it isn't limited */
export async function availableIn(key: string, max: number): Promise<number> {
    const attempts = (await Cache.get<number>(`rate-limit:${key}`)) ?? 0
    const resetAt = await Cache.get<number>(`rate-limit:${key}:timer`)
    if (attempts < max || resetAt === null) {
        return 0
    }
    return Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))
}

export async function clearAttempts(key: string): Promise<void> {
    await Cache.forget(`rate-limit:${key}`, `rate-limit:${key}:timer`)
}
