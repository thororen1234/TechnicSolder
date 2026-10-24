import { Store, type SessionData } from 'express-session'
import type { Redis } from 'ioredis'

const PREFIX = 'solder_session:'

/** Seconds a session without a cookie expiry is kept */
const DEFAULT_TTL = 86_400

/** Seconds until the session's cookie expires */
function ttlOf(session: SessionData): number {
    const expires = session.cookie?.expires
    return expires ? Math.ceil((new Date(expires).getTime() - Date.now()) / 1000) : DEFAULT_TTL
}

/**
 * Sessions in Redis on the shared ioredis connection. connect-redis only speaks node-redis: with ioredis its SET
 * fails, so no session was ever saved and every form failed the CSRF check.
 */
export class RedisSessionStore extends Store {
    constructor(private redis: Redis) {
        super()
    }

    override get(sid: string, callback: (error: unknown, session?: SessionData | null) => void): void {
        this.redis.get(PREFIX + sid).then(
            (raw) => callback(null, raw === null ? null : (JSON.parse(raw) as SessionData)),
            (error: unknown) => callback(error),
        )
    }

    override set(sid: string, session: SessionData, callback?: (error?: unknown) => void): void {
        const ttl = ttlOf(session)
        const write = ttl > 0 ? this.redis.set(PREFIX + sid, JSON.stringify(session), 'EX', ttl) : this.redis.del(PREFIX + sid)
        write.then(
            () => callback?.(),
            (error: unknown) => callback?.(error),
        )
    }

    override touch(sid: string, session: SessionData, callback?: (error?: unknown) => void): void {
        this.redis.expire(PREFIX + sid, Math.max(1, ttlOf(session))).then(
            () => callback?.(),
            (error: unknown) => callback?.(error),
        )
    }

    override destroy(sid: string, callback?: (error?: unknown) => void): void {
        this.redis.del(PREFIX + sid).then(
            () => callback?.(),
            (error: unknown) => callback?.(error),
        )
    }
}
