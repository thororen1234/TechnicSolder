import { Controller, Delete, Get, Post, Put, Req, Res, UseGuards } from '@nestjs/common'
import type { Request, Response } from 'express'
import { config, SOLDER_STREAM, SOLDER_VERSION } from '../config.js'
import { db } from '../database/prisma.js'
import { recordActivity } from '../models/activity-log.js'
import { apiAuthContext, type ApiAuthContext } from '../models/api-auth.js'
import { isBuildAccessibleBy, NOT_FOUND_CACHE_VALUE } from '../models/build.js'
import { recordBuildDownload } from '../models/build-download.js'
import { isModpackAccessibleBy, modpackApiResponse } from '../models/modpack.js'
import { toApiResponse } from '../models/modversion.js'
import { canAccessModpack, grantModpackAccess } from '../models/permissions.js'
import { buildsForModpack, modversionIdsForBuild, modversionsForBuild, syncBuildModversions, syncClientModpacks } from '../models/relations.js'
import { serialize } from '../models/serialize.js'
import type { Build, Modpack, ModversionWithMod } from '../models/types.js'
import { AuthGuard } from '../http/guards.js'
import { authorize, Policies } from '../policies/gate.js'
import { Cache, MINUTE } from '../support/cache.js'
import { naturalCompare, slug as toSlug } from '../support/str.js'
import { Rule } from '../support/validation.js'
import { JAVA_RUNTIMES } from '../models/java.js'
import { api, apiValidate, castColumns, only } from './api-helpers.js'

interface CachedModpack {
    modpack: Modpack
    builds: Build[]
}

interface CachedBuild {
    build: Build
    modversions: ModversionWithMod[]
}

const BUILD_FIELDS = ['version', 'minecraft', 'forge', 'is_published', 'private', 'min_java', 'java_runtime', 'min_memory'] as const

async function cachedModpack(slug: string): Promise<CachedModpack | null> {
    return Cache.remember(`modpack:${slug}`, 5 * MINUTE, async () => {
        const modpack = await db.modpack.findFirst({ where: { slug } })
        return modpack ? { modpack, builds: await buildsForModpack(modpack.id) } : null
    })
}

async function fetchModpack(slug: string, auth: ApiAuthContext): Promise<Record<string, unknown> | null> {
    const cached = await cachedModpack(slug)
    if (!cached) {
        return null
    }
    if (cached.modpack.private && !isModpackAccessibleBy(cached.modpack, auth)) {
        return null
    }
    return modpackApiResponse(cached.modpack, cached.builds, auth)
}

async function forgetModpack(slug: string, ...more: string[]): Promise<void> {
    await Cache.forget(`modpack:${slug}`, 'modpacks', 'allmodpacks', ...more)
}

@Controller('api')
export class ApiModpackController {
    @Get()
    root(@Req() req: Request, @Res() res: Response): void {
        api(req, res).json({ api: 'TechnicSolder', version: SOLDER_VERSION, stream: SOLDER_STREAM })
    }

    @Get('modpack')
    async index(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = api(req, res)
        const auth = await apiAuthContext(web.all(), req.user ?? null)
        const all = await Cache.remember('modpacks', 5 * MINUTE, () => db.modpack.findMany({ orderBy: { id: 'asc' } }))
        const modpacks = all.filter((modpack) => (!modpack.private && !modpack.hidden) || isModpackAccessibleBy(modpack, auth))
        const response: Record<string, unknown> = {}
        if (web.input('include') === 'full') {
            const full: Record<string, unknown> = {}
            for (const modpack of modpacks) {
                full[modpack.slug] = await fetchModpack(modpack.slug, auth)
            }
            response.modpacks = full
        } else {
            response.modpacks = Object.fromEntries(modpacks.map((modpack) => [modpack.slug, modpack.name]))
        }
        response.mirror_url = config.solder.mirror_url
        web.json(response)
    }

    @Get('modpack/:slug')
    async show(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = api(req, res)
        const auth = await apiAuthContext(web.all(), req.user ?? null)
        const response = await fetchModpack(req.params.slug as string, auth)
        if (!response) {
            web.json({ error: 'Modpack does not exist' }, 404)
            return
        }
        web.json(response)
    }

    @Get('modpack/:slug/:version')
    async showBuild(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = api(req, res)
        const slug = req.params.slug as string
        const version = req.params.version as string
        const auth = await apiAuthContext(web.all(), req.user ?? null)
        const cached = await cachedModpack(slug)
        if (!cached || (cached.modpack.private && !isModpackAccessibleBy(cached.modpack, auth))) {
            web.json({ error: 'Modpack does not exist' }, 404)
            return
        }
        const buildCacheKey = `modpack:${slug}:build:${version}`
        let entry = await Cache.get<CachedBuild | typeof NOT_FOUND_CACHE_VALUE>(buildCacheKey)
        if (!entry) {
            const build = cached.builds.find((candidate) => candidate.version === version)
            if (build) {
                entry = { build, modversions: await modversionsForBuild(build.id) }
                await Cache.put(buildCacheKey, entry, 5 * MINUTE)
            } else {
                entry = NOT_FOUND_CACHE_VALUE
                await Cache.put(buildCacheKey, entry, MINUTE)
            }
        }
        if (entry === NOT_FOUND_CACHE_VALUE || !isBuildAccessibleBy(entry.build, cached.modpack, auth)) {
            web.json({ error: 'Build does not exist' }, 404)
            return
        }
        const { build, modversions } = entry
        await recordBuildDownload(build.id)
        const includeFullMods = web.input('include') === 'mods'
        // The stable name sort preserves ascending IDs when names compare equal
        const mods = [...modversions]
            .sort((a, b) => a.id - b.id)
            .map((modversion) => toApiResponse(modversion, includeFullMods))
            .sort((a, b) => naturalCompare(String(a.name), String(b.name)))
        web.json({
            id: build.id,
            minecraft: build.minecraft,
            java: build.min_java,
            java_runtime: build.java_runtime,
            memory: build.min_memory,
            forge: build.forge,
            mods,
        })
    }

    @Post('modpack')
    @UseGuards(AuthGuard)
    async store(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = api(req, res)
        authorize(req.user, Policies.modpack.create())
        if (!(await apiValidate(web, { name: 'required|unique:modpacks', slug: 'required|unique:modpacks|alpha_dash', url: 'nullable|url' }))) {
            return
        }
        const data = castColumns(only(web, ['name', 'slug', 'hidden', 'private', 'url', 'order']))
        if (data.order === null) {
            delete data.order
        }
        const modpack = await db.modpack.create({ data: data as Modpack })
        await Cache.forget('modpacks', 'allmodpacks')
        web.json(serialize(modpack), 201)
    }

    @Post('modpack/:slug/clone')
    @UseGuards(AuthGuard)
    async clone(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = api(req, res)
        const modpack = await db.modpack.findFirst({ where: { slug: req.params.slug as string } })
        if (!modpack) {
            web.json({ error: 'Modpack not found.' }, 404)
            return
        }
        authorize(req.user, Policies.modpack.create())
        authorize(req.user, Policies.modpack.update(modpack))
        const slug = toSlug(web.string('slug'))
        if (!(await apiValidate(web, { name: 'required|unique:modpacks', slug: 'required|unique:modpacks|alpha_dash' }, { ...web.all(), slug }))) {
            return
        }
        const newModpack = await db.$transaction(async (tx) => {
            const { id: _id, created_at: _created, updated_at: _updated, ...attributes } = modpack
            const created = await tx.modpack.create({
                data: { ...attributes, name: web.string('name'), slug, hidden: web.boolean('hidden'), url: null, order: 0 },
            })
            for (const build of await buildsForModpack(modpack.id, tx)) {
                const newBuild = await tx.build.create({
                    data: { modpack_id: created.id, ...Object.fromEntries(BUILD_FIELDS.map((field) => [field, build[field]])) } as Build,
                })
                await syncBuildModversions(newBuild.id, await modversionIdsForBuild(build.id, tx), tx)
            }
            return created
        })
        const user = req.user!
        if (user.permission) {
            await grantModpackAccess(user.permission, newModpack.id)
        }
        await Cache.forget('modpacks', 'allmodpacks')
        web.json({ ...serialize(newModpack), builds: (await buildsForModpack(newModpack.id)).map((build) => serialize(build)) }, 201)
    }

    @Put('modpack/:slug')
    @UseGuards(AuthGuard)
    async update(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = api(req, res)
        const modpack = await db.modpack.findFirst({ where: { slug: req.params.slug as string } })
        if (!modpack) {
            web.json({ error: 'Modpack not found.' }, 404)
            return
        }
        authorize(req.user, Policies.modpack.update(modpack))
        const rules = {
            name: [`sometimes`, `required`, Rule.unique('modpacks', 'name').ignore(modpack.id)],
            slug: ['sometimes', 'required', 'alpha_dash', Rule.unique('modpacks', 'slug').ignore(modpack.id)],
            url: 'nullable|url',
        }
        if (!(await apiValidate(web, rules))) {
            return
        }
        const data = castColumns(only(web, ['name', 'slug', 'hidden', 'private', 'url', 'order', 'recommended', 'latest']))
        if (data.order === null) {
            data.order = 0
        }
        const updated = await db.modpack.update({ where: { id: modpack.id }, data })
        await forgetModpack(modpack.slug)
        if (modpack.slug !== updated.slug) {
            await Cache.forget(`modpack:${updated.slug}`)
        }
        web.json(serialize(updated))
    }

    @Delete('modpack/:slug')
    @UseGuards(AuthGuard)
    async destroy(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = api(req, res)
        const slug = req.params.slug as string
        const modpack = await db.modpack.findFirst({ where: { slug } })
        if (!modpack) {
            web.json({ error: 'Modpack not found.' }, 404)
            return
        }
        authorize(req.user, Policies.modpack.delete(modpack))
        for (const build of await buildsForModpack(modpack.id)) {
            await db.buildModversion.deleteMany({ where: { build_id: build.id } })
            await Cache.forget(`modpack:${slug}:build:${build.version}`)
            await db.build.delete({ where: { id: build.id } })
        }
        await syncClientModpacks({ modpack_id: modpack.id }, [])
        await db.modpack.delete({ where: { id: modpack.id } })
        await forgetModpack(slug, 'clients')
        web.json({ success: 'Modpack deleted.' })
    }

    @Post('modpack/:slug/build')
    @UseGuards(AuthGuard)
    async storeBuild(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = api(req, res)
        const slug = req.params.slug as string
        const modpack = await db.modpack.findFirst({ where: { slug } })
        if (!modpack) {
            web.json({ error: 'Modpack not found.' }, 404)
            return
        }
        authorize(req.user, Policies.build.create(modpack))
        const rules = {
            version: 'required',
            minecraft: 'required',
            java_runtime: ['nullable', 'string', Rule.enum(JAVA_RUNTIMES)],
            clone_from: 'sometimes|string',
            clone_from_modpack: 'sometimes|string|exists:modpacks,slug',
        }
        if (!(await apiValidate(web, rules))) {
            return
        }
        if ((await db.build.count({ where: { modpack_id: modpack.id, version: web.string('version') } })) > 0) {
            web.json({ error: 'Build version already exists for this modpack.' }, 422)
            return
        }
        // Validate the clone source before creating the build
        let cloneSource: Build | null = null
        if (web.filled('clone_from')) {
            if (web.filled('clone_from_modpack')) {
                const sourceModpack = await db.modpack.findFirst({ where: { slug: web.string('clone_from_modpack') } })
                if (!sourceModpack) {
                    web.json({ error: 'Clone source modpack not found.' }, 404)
                    return
                }
                if (!canAccessModpack(req.user!.permission, sourceModpack.id)) {
                    web.json({ error: 'You do not have permission to clone from that modpack.' }, 403)
                    return
                }
                cloneSource = await db.build.findFirst({ where: { modpack_id: sourceModpack.id, version: web.string('clone_from') } })
            } else {
                cloneSource = await db.build.findFirst({ where: { modpack_id: modpack.id, version: web.string('clone_from') } })
            }
            if (!cloneSource) {
                web.json({ error: 'Clone source build not found.' }, 404)
                return
            }
        }
        const build = await db.build.create({ data: { ...castColumns(only(web, BUILD_FIELDS)), modpack_id: modpack.id } as Build })
        if (cloneSource) {
            await syncBuildModversions(build.id, await modversionIdsForBuild(cloneSource.id))
        }
        await Cache.forget(`modpack:${slug}`)
        web.json(serialize(build), 201)
    }

    @Put('modpack/:slug/:version')
    @UseGuards(AuthGuard)
    async updateBuild(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = api(req, res)
        const slug = req.params.slug as string
        const version = req.params.version as string
        const modpack = await db.modpack.findFirst({ where: { slug } })
        if (!modpack) {
            web.json({ error: 'Modpack not found.' }, 404)
            return
        }
        authorize(req.user, Policies.build.update(modpack))
        const build = await db.build.findFirst({ where: { modpack_id: modpack.id, version } })
        if (!build) {
            web.json({ error: 'Build not found.' }, 404)
            return
        }
        if (!(await apiValidate(web, { java_runtime: ['nullable', 'string', Rule.enum(JAVA_RUNTIMES)] }))) {
            return
        }
        const updated = await db.build.update({ where: { id: build.id }, data: castColumns(only(web, BUILD_FIELDS)) })
        await Cache.forget(`modpack:${slug}`, `modpack:${slug}:build:${version}`)
        if (version !== updated.version) {
            await Cache.forget(`modpack:${slug}:build:${updated.version}`)
        }
        web.json(serialize(updated))
    }

    @Delete('modpack/:slug/:version')
    @UseGuards(AuthGuard)
    async destroyBuild(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = api(req, res)
        const slug = req.params.slug as string
        const version = req.params.version as string
        const modpack = await db.modpack.findFirst({ where: { slug } })
        if (!modpack) {
            web.json({ error: 'Modpack not found.' }, 404)
            return
        }
        authorize(req.user, Policies.build.delete(modpack))
        const build = await db.build.findFirst({ where: { modpack_id: modpack.id, version } })
        if (!build) {
            web.json({ error: 'Build not found.' }, 404)
            return
        }
        await db.buildModversion.deleteMany({ where: { build_id: build.id } })
        await db.build.delete({ where: { id: build.id } })
        await Cache.forget(`modpack:${slug}`, `modpack:${slug}:build:${version}`)
        web.json({ success: 'Build deleted.' })
    }

    @Post('modpack/:slug/:version/mod')
    @UseGuards(AuthGuard)
    async addMod(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = api(req, res)
        const found = await this.findBuild(web.req, web)
        if (!found) {
            return
        }
        const { slug, version, build } = found
        if (!(await apiValidate(web, { mod_slug: 'required|string', mod_version: 'required|string' }))) {
            return
        }
        const mod = await db.mod.findUnique({ where: { name: web.string('mod_slug') } })
        if (!mod) {
            web.json({ error: 'Mod not found.' }, 404)
            return
        }
        const modversion = await db.modversion.findFirst({ where: { mod_id: mod.id, version: web.string('mod_version') } })
        if (!modversion) {
            web.json({ error: 'Mod version not found.' }, 404)
            return
        }
        const current = await modversionsForBuild(build.id)
        if (current.some((candidate) => candidate.id === modversion.id)) {
            web.json({ error: 'Mod version already in build.' }, 422)
            return
        }
        if (current.some((candidate) => candidate.mod_id === mod.id)) {
            web.json({ error: 'Another version of this mod is already in the build. Use PUT to update it.' }, 422)
            return
        }
        await db.buildModversion.create({ data: { build_id: build.id, modversion_id: modversion.id } })
        await recordActivity('build.mod_added', `Added ${mod.pretty_name || mod.name} ${modversion.version} to build ${build.version} (API)`, {
            build,
            properties: { mod: mod.name, version: modversion.version },
        })
        await Cache.forget(`modpack:${slug}:build:${version}`, `modpack:${slug}`)
        web.json({ success: 'Mod added to build.' }, 201)
    }

    @Put('modpack/:slug/:version/mod/:modSlug')
    @UseGuards(AuthGuard)
    async changeMod(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = api(req, res)
        const found = await this.findBuild(web.req, web)
        if (!found) {
            return
        }
        const { slug, version, build } = found
        const mod = await db.mod.findUnique({ where: { name: req.params.modSlug as string } })
        if (!mod) {
            web.json({ error: 'Mod not found.' }, 404)
            return
        }
        if (!(await apiValidate(web, { mod_version: 'required|string' }))) {
            return
        }
        const newModversion = await db.modversion.findFirst({ where: { mod_id: mod.id, version: web.string('mod_version') } })
        if (!newModversion) {
            web.json({ error: 'Mod version not found.' }, 404)
            return
        }
        const oldModversion = (await modversionsForBuild(build.id)).find((candidate) => candidate.mod_id === mod.id)
        if (!oldModversion) {
            web.json({ error: 'Mod not in this build.' }, 404)
            return
        }
        await db.buildModversion.deleteMany({ where: { build_id: build.id, modversion_id: oldModversion.id } })
        await db.buildModversion.create({ data: { build_id: build.id, modversion_id: newModversion.id } })
        await recordActivity(
            'build.mod_changed',
            `Changed ${mod.pretty_name || mod.name} from ${oldModversion.version} to ${newModversion.version} in build ${build.version} (API)`,
            { build, properties: { mod: mod.name, from: oldModversion.version, to: newModversion.version } },
        )
        await Cache.forget(`modpack:${slug}:build:${version}`, `modpack:${slug}`)
        web.json({ success: 'Mod version updated in build.' })
    }

    @Delete('modpack/:slug/:version/mod/:modSlug')
    @UseGuards(AuthGuard)
    async removeMod(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = api(req, res)
        const found = await this.findBuild(web.req, web)
        if (!found) {
            return
        }
        const { slug, version, build } = found
        const mod = await db.mod.findUnique({ where: { name: req.params.modSlug as string } })
        if (!mod) {
            web.json({ error: 'Mod not found.' }, 404)
            return
        }
        const modversion = (await modversionsForBuild(build.id)).find((candidate) => candidate.mod_id === mod.id)
        if (!modversion) {
            web.json({ error: 'Mod not in this build.' }, 404)
            return
        }
        await db.buildModversion.deleteMany({ where: { build_id: build.id, modversion_id: modversion.id } })
        await recordActivity('build.mod_removed', `Removed ${mod.pretty_name || mod.name} ${modversion.version} from build ${build.version} (API)`, {
            build,
            properties: { mod: mod.name, version: modversion.version },
        })
        await Cache.forget(`modpack:${slug}:build:${version}`, `modpack:${slug}`)
        web.json({ success: 'Mod removed from build.' })
    }

    /** The modpack and build named in the URL, after checking the user may change the build */
    private async findBuild(req: Request, web: ReturnType<typeof api>): Promise<{ slug: string; version: string; build: Build } | null> {
        const slug = req.params.slug as string
        const version = req.params.version as string
        const modpack = await db.modpack.findFirst({ where: { slug } })
        if (!modpack) {
            web.json({ error: 'Modpack not found.' }, 404)
            return null
        }
        authorize(req.user, Policies.build.update(modpack))
        const build = await db.build.findFirst({ where: { modpack_id: modpack.id, version } })
        if (!build) {
            web.json({ error: 'Build not found.' }, 404)
            return null
        }
        return { slug, version, build }
    }
}

