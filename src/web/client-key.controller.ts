import { Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common'
import type { Request, Response } from 'express'
import { db } from '../database/prisma.js'
import { AuthGuard } from '../http/guards.js'
import { Web } from '../http/web.js'
import { syncClientModpacks } from '../models/relations.js'
import { authorize, Policies } from '../policies/gate.js'
import { Cache } from '../support/cache.js'
import { validate } from '../support/validation.js'

function id(req: Request, name: string): number | null {
    const value = Number(req.params[name])
    return Number.isInteger(value) ? value : null
}

@Controller()
@UseGuards(AuthGuard)
export class ClientController {
    @Get('client')
    index(@Req() req: Request, @Res() res: Response): void {
        Web.of(req, res).redirect('client/list').send()
    }

    @Get('client/list')
    async list(@Req() req: Request, @Res() res: Response): Promise<void> {
        authorize(req.user, Policies.client.viewAny())
        await Web.of(req, res).view('client.list', { clients: await db.client.findMany({ orderBy: { id: 'asc' } }) })
    }

    @Get('client/create')
    async create(@Req() req: Request, @Res() res: Response): Promise<void> {
        authorize(req.user, Policies.client.create())
        await Web.of(req, res).view('client.create')
    }

    @Post('client/create')
    async store(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        authorize(req.user, Policies.client.create())
        const result = await validate(web.all(), { name: 'required|unique:clients', uuid: 'required|unique:clients' })
        if (!result.passes) {
            web.redirect('client/create').withErrors(result.errors).send()
            return
        }
        await db.client.create({ data: { name: web.string('name'), uuid: web.string('uuid') } })
        await Cache.forget('clients')
        web.redirect('client/list').with('success', 'Client added!').send()
    }

    @Get('client/delete/:client_id')
    async delete(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const clientId = id(req, 'client_id')
        const client = clientId === null ? null : await db.client.findUnique({ where: { id: clientId } })
        if (!client) {
            web.redirect('client/list').withErrors(['Client UUID not found']).send()
            return
        }
        authorize(req.user, Policies.client.delete())
        await web.view('client.delete', { client })
    }

    @Post('client/delete/:client_id')
    async destroy(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const clientId = id(req, 'client_id')
        const client = clientId === null ? null : await db.client.findUnique({ where: { id: clientId } })
        if (!client) {
            web.redirect('client/list').withErrors(['Client UUID not found']).send()
            return
        }
        authorize(req.user, Policies.client.delete())
        await syncClientModpacks({ client_id: client.id }, [])
        await db.client.delete({ where: { id: client.id } })
        await Cache.forget('clients')
        web.redirect('client/list').with('success', 'Client deleted!').send()
    }
}

@Controller()
@UseGuards(AuthGuard)
export class KeyController {
    @Get('key')
    index(@Req() req: Request, @Res() res: Response): void {
        Web.of(req, res).redirect('key/list').send()
    }

    @Get('key/list')
    async list(@Req() req: Request, @Res() res: Response): Promise<void> {
        authorize(req.user, Policies.key.viewAny())
        await Web.of(req, res).view('key.list', { keys: await db.key.findMany({ orderBy: { id: 'asc' } }) })
    }

    @Get('key/create')
    async create(@Req() req: Request, @Res() res: Response): Promise<void> {
        authorize(req.user, Policies.key.create())
        await Web.of(req, res).view('key.create')
    }

    @Post('key/create')
    async store(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        authorize(req.user, Policies.key.create())
        const result = await validate(web.all(), { name: 'required|unique:keys', api_key: 'required|unique:keys' })
        if (!result.passes) {
            web.redirect('key/create').withErrors(result.errors).send()
            return
        }
        await db.key.create({ data: { name: web.string('name'), api_key: web.string('api_key') } })
        await Cache.forget('keys')
        web.redirect('key/list').with('success', 'Platform key added!').send()
    }

    @Get('key/delete/:key_id')
    async delete(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const keyId = id(req, 'key_id')
        const key = keyId === null ? null : await db.key.findUnique({ where: { id: keyId } })
        if (!key) {
            web.redirect('key/list').withErrors(['Platform Key not found']).send()
            return
        }
        authorize(req.user, Policies.key.delete())
        await web.view('key.delete', { key })
    }

    @Post('key/delete/:key_id')
    async destroy(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const keyId = id(req, 'key_id')
        const key = keyId === null ? null : await db.key.findUnique({ where: { id: keyId } })
        if (!key) {
            web.redirect('key/list').withErrors(['Platform Key not found']).send()
            return
        }
        authorize(req.user, Policies.key.delete())
        await db.key.delete({ where: { id: key.id } })
        await Cache.forget('keys')
        web.redirect('key/list').with('success', 'Platform Key deleted!').send()
    }
}
