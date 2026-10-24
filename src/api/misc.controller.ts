import { Controller, Delete, Get, Post, Put, Req, Res, UseGuards } from '@nestjs/common'
import type { Request, Response } from 'express'
import { createToken, tokensFor, TOKENABLE_TYPE } from '../auth/tokens.js'
import { db } from '../database/prisma.js'
import { AuthGuard } from '../http/guards.js'
import { throttle } from '../http/rate-limit.js'
import { cachedKeys, hashEquals } from '../models/api-auth.js'
import { syncClientModpacks } from '../models/relations.js'
import { serialize } from '../models/serialize.js'
import { authorize, Policies } from '../policies/gate.js'
import { getMinecraftVersions } from '../services/minecraft.js'
import { Cache } from '../support/cache.js'
import { toJsonDate } from '../support/dates.js'
import { api, apiValidate, only } from './api-helpers.js'

@Controller('api')
export class ApiMiscController {
    @Get('verify/:key')
    async verify(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = api(req, res)
        await throttle(`key-verify:${req.ip}`, 10, 60)
        const match = (await cachedKeys()).find((key) => hashEquals(key.api_key, req.params.key as string))
        if (!match) {
            web.json({ error: 'Invalid key provided.' }, 403)
            return
        }
        web.json({ valid: 'Key validated.', name: match.name })
    }

    @Post('client')
    @UseGuards(AuthGuard)
    async storeClient(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = api(req, res)
        authorize(req.user, Policies.client.create())
        if (!(await apiValidate(web, { name: 'required|unique:clients', uuid: 'required|unique:clients' }))) {
            return
        }
        const client = await db.client.create({ data: { name: web.string('name'), uuid: web.string('uuid') } })
        await Cache.forget('clients')
        web.json(serialize(client), 201)
    }

    @Put('client/:uuid')
    @UseGuards(AuthGuard)
    async updateClient(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = api(req, res)
        const client = await db.client.findFirst({ where: { uuid: req.params.uuid as string } })
        if (!client) {
            web.json({ error: 'Client not found.' }, 404)
            return
        }
        authorize(req.user, Policies.client.update())
        if (web.has('modpacks')) {
            if (!(await apiValidate(web, { modpacks: 'array', 'modpacks.*': 'integer|exists:modpacks,id' }))) {
                return
            }
            await syncClientModpacks({ client_id: client.id }, web.array('modpacks').map(Number))
        }
        let updated = client
        if (web.has('name')) {
            updated = await db.client.update({ where: { id: client.id }, data: only(web, ['name']) as { name: string } })
        }
        await Cache.forget('clients')
        web.json(serialize(updated))
    }

    @Delete('client/:uuid')
    @UseGuards(AuthGuard)
    async destroyClient(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = api(req, res)
        const client = await db.client.findFirst({ where: { uuid: req.params.uuid as string } })
        if (!client) {
            web.json({ error: 'Client not found.' }, 404)
            return
        }
        authorize(req.user, Policies.client.delete())
        await syncClientModpacks({ client_id: client.id }, [])
        await db.client.delete({ where: { id: client.id } })
        await Cache.forget('clients')
        web.json({ success: 'Client deleted.' })
    }

    @Get('token')
    @UseGuards(AuthGuard)
    async tokens(@Req() req: Request, @Res() res: Response): Promise<void> {
        const tokens = (await tokensFor(req.user!.id)).map((token) => ({
            id: token.id,
            name: token.name,
            last_used_at: toJsonDate(token.last_used_at),
            created_at: toJsonDate(token.created_at),
        }))
        api(req, res).json({ tokens })
    }

    @Post('token')
    @UseGuards(AuthGuard)
    async storeToken(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = api(req, res)
        if (!(await apiValidate(web, { name: 'required|string|max:255' }))) {
            return
        }
        const token = await createToken(req.user!, web.string('name'))
        web.json(
            {
                token: {
                    id: token.accessToken.id,
                    name: token.accessToken.name,
                    plaintext: token.plainTextToken,
                    created_at: toJsonDate(token.accessToken.created_at),
                },
            },
            201,
        )
    }

    @Delete('token/:tokenId')
    @UseGuards(AuthGuard)
    async destroyToken(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = api(req, res)
        const id = Number(req.params.tokenId)
        const token = Number.isInteger(id)
            ? await db.personalAccessToken.findFirst({ where: { id, tokenable_type: TOKENABLE_TYPE, tokenable_id: req.user!.id } })
            : null
        if (!token) {
            web.json({ error: 'Token not found.' }, 404)
            return
        }
        await db.personalAccessToken.delete({ where: { id: token.id } })
        web.json({ success: 'Token revoked.' })
    }

    @Post('minecraft/refresh')
    @UseGuards(AuthGuard)
    async refreshMinecraft(@Req() req: Request, @Res() res: Response): Promise<void> {
        await getMinecraftVersions(true)
        api(req, res).json({ success: 'Minecraft versions cache refreshed.' })
    }
}
