import type { SessionData } from 'express-session'
import type { Redis } from 'ioredis'
import { RedisSessionStore } from '../../src/http/session-store.js'
import { useSolder } from '../support/helpers.js'

/** The ioredis calls the store makes, kept in memory with their TTLs */
class FakeRedis {
    values = new Map<string, string>()
    ttls = new Map<string, number>()
    calls: unknown[][] = []

    async get(key: string): Promise<string | null> {
        return this.values.get(key) ?? null
    }

    async set(key: string, value: string, ...args: unknown[]): Promise<'OK'> {
        this.calls.push(['set', key, ...args])
        if (args.length !== 0 && (args.length !== 2 || args[0] !== 'EX' || typeof args[1] !== 'number')) {
            throw new Error('ERR syntax error')
        }
        this.values.set(key, value)
        this.ttls.set(key, args[1] as number)
        return 'OK'
    }

    async expire(key: string, seconds: number): Promise<number> {
        this.ttls.set(key, seconds)
        return this.values.has(key) ? 1 : 0
    }

    async del(...keys: string[]): Promise<number> {
        return keys.filter((key) => this.values.delete(key)).length
    }
}

function session(expiresInSeconds?: number): SessionData {
    const expires = expiresInSeconds === undefined ? undefined : new Date(Date.now() + expiresInSeconds * 1000)
    return { cookie: { originalMaxAge: null, expires }, _token: 'token' } as unknown as SessionData
}

function call<T>(run: (callback: (error?: unknown, value?: T) => void) => void): Promise<T | undefined> {
    return new Promise((resolve, reject) => run((error, value) => (error ? reject(error) : resolve(value))))
}

describe('RedisSessionStore', () => {
    useSolder({ seed: false })

    let fake: FakeRedis
    let store: RedisSessionStore

    beforeEach(() => {
        fake = new FakeRedis()
        store = new RedisSessionStore(fake as unknown as Redis)
    })

    it('saves a session with an ioredis EX expiry and reads it back', async () => {
        await call((done) => store.set('abc', session(7200), done))

        expect(fake.calls).toEqual([['set', 'solder_session:abc', 'EX', 7200]])
        expect(await call<SessionData | null>((done) => store.get('abc', done))).toMatchObject({ _token: 'token' })
    })

    it('keeps a session without a cookie expiry for a day', async () => {
        await call((done) => store.set('abc', session(), done))

        expect(fake.ttls.get('solder_session:abc')).toBe(86_400)
    })

    it('returns null for an unknown session', async () => {
        expect(await call((done) => store.get('missing', done))).toBeNull()
    })

    it('deletes a session whose cookie already expired instead of saving it', async () => {
        fake.values.set('solder_session:abc', '{}')

        await call((done) => store.set('abc', session(-10), done))

        expect(fake.values.has('solder_session:abc')).toBe(false)
        expect(fake.calls).toEqual([])
    })

    it('extends the expiry on touch', async () => {
        await call((done) => store.set('abc', session(60), done))
        await call((done) => store.touch('abc', session(3600), done))

        expect(fake.ttls.get('solder_session:abc')).toBe(3600)
    })

    it('destroys a session', async () => {
        await call((done) => store.set('abc', session(60), done))
        await call((done) => store.destroy('abc', done))

        expect(await call((done) => store.get('abc', done))).toBeNull()
    })

    it('passes Redis errors to the callback', async () => {
        fake.get = async () => {
            throw new Error('connection lost')
        }

        await expect(call((done) => store.get('abc', done))).rejects.toThrow('connection lost')
    })
})
