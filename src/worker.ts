import './jobs/build-jobs.js'
import './jobs/check-all-build-updates.js'
import './jobs/check-mod-repository.js'
import './jobs/import-modpack.js'
import { config } from './config.js'
import { connectDatabase, disconnectDatabase } from './database/prisma.js'
import { startWorker } from './jobs/queue.js'
import { closeRedis } from './support/cache.js'
import { logger } from './support/logger.js'

/** The queue worker: runs modpack imports, exports and update checks (QUEUE_CONNECTION=redis) */
if (config.queueConnection !== 'redis') {
    logger.warn('QUEUE_CONNECTION is not "redis", so jobs run during web requests and this worker has nothing to do.')
}
await connectDatabase()
const worker = startWorker()
logger.info('Queue worker started')

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        void (async () => {
            await worker.close()
            await disconnectDatabase()
            await closeRedis()
            process.exit(0)
        })()
    })
}
