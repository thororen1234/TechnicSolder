import 'reflect-metadata'
import { Module, type INestApplication } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import express from 'express'
import { ApiMiscController } from './api/misc.controller.js'
import { ApiModController } from './api/mod.controller.js'
import { ApiModpackController } from './api/modpack.controller.js'
import { config } from './config.js'
import { connectDatabase } from './database/prisma.js'
import { registerRoutes, SolderExceptionFilter } from './http/exception.filter.js'
import {
    cors,
    flashAndToken,
    forceJson,
    loadSessionUser,
    loadTokenUser,
    multipart,
    normalizeInput,
    requestContext,
    securityHeaders,
    sessionMiddleware,
    split,
    throttleApi,
    verifyCsrfToken,
} from './http/middleware.js'
import { WEB_CONTROLLERS } from './web/index.js'

@Module({
    controllers: [ApiModpackController, ApiModController, ApiMiscController, ...WEB_CONTROLLERS],
})
export class AppModule {}

/** The configured Nest application, ready to listen (or to hand to supertest) */
export async function createApp(): Promise<INestApplication> {
    await connectDatabase()
    const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false, logger: ['error', 'warn'] })
    app.set('trust proxy', true)
    app.disable('x-powered-by')

    app.use(securityHeaders)
    app.use(express.static(config.paths.public, { index: false }))
    app.use('/up', (_req: express.Request, res: express.Response) => {
        res.status(200).type('html').send('<!DOCTYPE html><html><body>Application up</body></html>')
    })
    app.use(requestContext)
    app.use(express.json({ limit: '10mb' }))
    app.use(express.urlencoded({ extended: true, limit: '10mb', parameterLimit: 100_000 }))
    app.use(multipart)
    // HTML forms send PUT/DELETE as POST with _method
    app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
        const override = (req.body as Record<string, unknown> | undefined)?._method
        if (req.method === 'POST' && typeof override === 'string' && ['PUT', 'PATCH', 'DELETE'].includes(override.toUpperCase())) {
            req.method = override.toUpperCase()
        }
        next()
    })
    app.use(normalizeInput)
    app.use(split([sessionMiddleware(), flashAndToken, verifyCsrfToken, loadSessionUser], [forceJson, cors, loadTokenUser, throttleApi]))
    app.useGlobalFilters(new SolderExceptionFilter())
    await app.init()
    registerRoutes(app.getHttpAdapter().getInstance())
    return app
}
