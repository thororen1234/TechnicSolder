import { createApp } from './app.js'
import { config } from './config.js'
import { logger } from './support/logger.js'

/** The web server: the dashboard and the launcher API */
const app = await createApp()
await app.listen(config.app.port, '0.0.0.0')
logger.info(`Technic Solder listening on port ${config.app.port}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        void app.close().finally(() => process.exit(0))
    })
}
