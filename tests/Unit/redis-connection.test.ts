import { config } from '../../src/config.js'
import { closeRedis, redis } from '../../src/support/cache.js'
import { useSolder } from '../support/helpers.js'

describe('The shared Redis connection', () => {
    useSolder({ seed: false })

    afterEach(() => {
        redis().disconnect()
        void closeRedis().catch(() => {})
    })

    it('fails commands quickly while Redis is unreachable instead of hanging requests', async () => {
        // Nothing listens on port 1, so every connection attempt is refused
        config.redis.host = '127.0.0.1'
        config.redis.port = 1
        const started = Date.now()

        await expect(redis().get('anything')).rejects.toThrow()

        expect(Date.now() - started).toBeLessThan(5000)
    })
})
