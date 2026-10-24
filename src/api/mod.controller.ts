import { Controller, Delete, Get, Post, Put, Req, Res, UseGuards } from '@nestjs/common'
import type { Request, Response } from 'express'
import { config } from '../config.js'
import { db } from '../database/prisma.js'
import { apiAuthContext } from '../models/api-auth.js'
import { isBuildAccessibleBy } from '../models/build.js'
import { downloadUrl } from '../models/modversion.js'
import { buildsForModversions, modpacksByIds, versionsForMod } from '../models/relations.js'
import { only as pick, serialize } from '../models/serialize.js'
import type { Mod, Modversion } from '../models/types.js'
import { allows, authorize, Policies } from '../policies/gate.js'
import { AuthGuard } from '../http/guards.js'
import { Cache, MINUTE } from '../support/cache.js'
import { Rule } from '../support/validation.js'
import { api, apiValidate, castColumns, only } from './api-helpers.js'

const MOD_FIELDS = ['name', 'pretty_name', 'description', 'author', 'link', 'notes'] as const

async function cachedMod(slug: string): Promise<{ mod: Mod; versions: Modversion[] } | null> {
    return Cache.remember(`mod:${slug}`, 5 * MINUTE, async () => {
        const mod = await db.mod.findUnique({ where: { name: slug } })
        return mod ? { mod, versions: await versionsForMod(mod.id) } : null
    })
}

/** SOLDER_DISABLE_MOD_API hides public mod reads from everyone but users who manage mods */
function modApiDisabled(req: Request): boolean {
    return config.solder.disable_mod_api && !allows(req.user, Policies.mod.viewAny())
}

function canSeeNotes(req: Request): boolean {
    const permission = req.user?.permission
    return Boolean(permission?.solder_full || permission?.mods_manage)
}

@Controller('api')
export class ApiModController {
    @Get('mod')
    async index(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = api(req, res)
        if (modApiDisabled(req)) {
            web.json({ error: 'Mod API has been disabled' }, 404)
            return
        }
        const mods = await Cache.remember('mods', 5 * MINUTE, async () =>
            Object.fromEntries((await db.mod.findMany({ orderBy: { id: 'asc' }, select: { name: true, pretty_name: true } })).map((mod) => [mod.name, mod.pretty_name])),
        )
        web.json({ mods })
    }

    @Get('mod/:slug')
    async show(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = api(req, res)
        if (modApiDisabled(req)) {
            web.json({ error: 'Mod API has been disabled' }, 404)
            return
        }
        const cached = await cachedMod(req.params.slug as string)
        if (!cached) {
            web.json({ error: 'Mod does not exist' }, 404)
            return
        }
        const response: Record<string, unknown> = pick(cached.mod, ['id', 'name', 'pretty_name', 'author', 'description', 'link'])
        if (canSeeNotes(req)) {
            response.notes = cached.mod.notes
        }
        response.versions = [...cached.versions].sort((a, b) => a.id - b.id).map((version) => version.version)
        web.json(response)
    }

    @Get('mod/:slug/:version')
    async showVersion(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = api(req, res)
        if (modApiDisabled(req)) {
            web.json({ error: 'Mod API has been disabled' }, 404)
            return
        }
        const auth = await apiAuthContext(web.all(), req.user ?? null)
        const cached = await cachedMod(req.params.slug as string)
        if (!cached) {
            web.json({ error: 'Mod does not exist' }, 404)
            return
        }
        const modversion = await db.modversion.findFirst({ where: { mod_id: cached.mod.id, version: req.params.version as string } })
        if (!modversion) {
            web.json({ error: 'Mod version does not exist' }, 404)
            return
        }
        const builds = (await buildsForModversions([modversion.id])).get(modversion.id) ?? []
        const modpacks = await modpacksByIds(builds.map((build) => build.modpack_id))
        const response: Record<string, unknown> = {
            id: modversion.id,
            md5: modversion.md5,
            filesize: modversion.filesize,
            url: downloadUrl(cached.mod, modversion.version),
            builds: builds
                .filter((build) => isBuildAccessibleBy(build, modpacks.get(build.modpack_id), auth))
                .sort((a, b) => a.id - b.id)
                .map((build) => {
                    const modpack = modpacks.get(build.modpack_id)!
                    return { id: build.id, version: build.version, modpack: { id: modpack.id, name: modpack.slug, display_name: modpack.name } }
                }),
        }
        if (canSeeNotes(req)) {
            response.notes = modversion.notes
        }
        web.json(response)
    }

    @Post('mod')
    @UseGuards(AuthGuard)
    async store(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = api(req, res)
        authorize(req.user, Policies.mod.create())
        if (!(await apiValidate(web, { name: 'required|unique:mods', pretty_name: 'required', link: 'nullable|url' }))) {
            return
        }
        const mod = await db.mod.create({ data: castColumns(only(web, MOD_FIELDS)) as Mod })
        await Cache.forget('mods')
        web.json(serialize(mod), 201)
    }

    @Put('mod/:slug')
    @UseGuards(AuthGuard)
    async update(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = api(req, res)
        const mod = await db.mod.findUnique({ where: { name: req.params.slug as string } })
        if (!mod) {
            web.json({ error: 'Mod not found.' }, 404)
            return
        }
        authorize(req.user, Policies.mod.update())
        const rules = {
            name: ['sometimes', 'required', Rule.unique('mods', 'name').ignore(mod.id)],
            pretty_name: 'sometimes|required',
            link: 'nullable|url',
        }
        if (!(await apiValidate(web, rules))) {
            return
        }
        const updated = await db.mod.update({ where: { id: mod.id }, data: castColumns(only(web, MOD_FIELDS)) })
        await Cache.forget(`mod:${mod.name}`, 'mods')
        if (mod.name !== updated.name) {
            await Cache.forget(`mod:${updated.name}`)
        }
        web.json(serialize(updated))
    }

    @Delete('mod/:slug')
    @UseGuards(AuthGuard)
    async destroy(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = api(req, res)
        const slug = req.params.slug as string
        const mod = await db.mod.findUnique({ where: { name: slug } })
        if (!mod) {
            web.json({ error: 'Mod not found.' }, 404)
            return
        }
        authorize(req.user, Policies.mod.delete())
        for (const version of await versionsForMod(mod.id)) {
            await db.buildModversion.deleteMany({ where: { modversion_id: version.id } })
            await db.modversion.delete({ where: { id: version.id } })
        }
        await db.mod.delete({ where: { id: mod.id } })
        await Cache.forget(`mod:${slug}`, 'mods')
        web.json({ success: 'Mod deleted.' })
    }

    @Post('mod/:slug/version')
    @UseGuards(AuthGuard)
    async storeVersion(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = api(req, res)
        const slug = req.params.slug as string
        authorize(req.user, Policies.modversion.create())
        const mod = await db.mod.findUnique({ where: { name: slug } })
        if (!mod) {
            web.json({ error: 'Mod not found.' }, 404)
            return
        }
        if (!(await apiValidate(web, { version: 'required', md5: 'required' }))) {
            return
        }
        if ((await db.modversion.count({ where: { mod_id: mod.id, version: web.string('version') } })) > 0) {
            web.json({ error: 'Version already exists for this mod.' }, 422)
            return
        }
        const modversion = await db.modversion.create({
            data: { ...castColumns(only(web, ['version', 'md5', 'filesize', 'notes'])), mod_id: mod.id } as Modversion,
        })
        await Cache.forget(`mod:${slug}`, 'mods')
        web.json(serialize(modversion), 201)
    }

    @Put('mod/:slug/:version')
    @UseGuards(AuthGuard)
    async updateVersion(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = api(req, res)
        const slug = req.params.slug as string
        authorize(req.user, Policies.modversion.update())
        const mod = await db.mod.findUnique({ where: { name: slug } })
        if (!mod) {
            web.json({ error: 'Mod not found.' }, 404)
            return
        }
        const modversion = await db.modversion.findFirst({ where: { mod_id: mod.id, version: req.params.version as string } })
        if (!modversion) {
            web.json({ error: 'Mod version not found.' }, 404)
            return
        }
        const updated = await db.modversion.update({ where: { id: modversion.id }, data: castColumns(only(web, ['md5', 'filesize', 'notes'])) })
        await Cache.forget(`mod:${slug}`)
        web.json(serialize(updated))
    }

    @Delete('mod/:slug/:version')
    @UseGuards(AuthGuard)
    async destroyVersion(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = api(req, res)
        const slug = req.params.slug as string
        authorize(req.user, Policies.modversion.delete())
        const mod = await db.mod.findUnique({ where: { name: slug } })
        if (!mod) {
            web.json({ error: 'Mod not found.' }, 404)
            return
        }
        const modversion = await db.modversion.findFirst({ where: { mod_id: mod.id, version: req.params.version as string } })
        if (!modversion) {
            web.json({ error: 'Mod version not found.' }, 404)
            return
        }
        const inUse = await db.buildModversion.count({ where: { modversion_id: modversion.id } })
        if (inUse > 0) {
            web.json({ error: `Mod version is in use by ${inUse} build(s) and cannot be deleted.` }, 409)
            return
        }
        await db.modversion.delete({ where: { id: modversion.id } })
        await Cache.forget(`mod:${slug}`, 'mods')
        web.json({ success: 'Mod version deleted.' })
    }
}

