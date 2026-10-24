import { readdirSync, rmdirSync, statSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common'
import type { Request, Response } from 'express'
import { config } from '../config.js'
import { db } from '../database/prisma.js'
import { AuthGuard } from '../http/guards.js'
import { Redirect, Web } from '../http/web.js'
import { formatFilesize, humanFilesize, CLIENT_ONLY, SERVER_ONLY } from '../models/modversion.js'
import { modpackIds } from '../models/permissions.js'
import { buildsForModversions, modpacksByIds, unusedModversionIds, versionsForMod, versionsForMods, withMods } from '../models/relations.js'
import { only } from '../models/serialize.js'
import type { Mod } from '../models/types.js'
import { emptySearch, latestStableVersionForGame } from '../mods/mod-provider.js'
import { providers } from '../mods/mod-providers.js'
import { authorize, Policies } from '../policies/gate.js'
import { ModRepository } from '../services/mod-repository.js'
import { ModUploadService, type UploadResult } from '../services/mod-upload.js'
import { remoteMd5 } from '../services/url-utils.js'
import { Cache, MINUTE } from '../support/cache.js'
import { fileSize, hashFile, isFile, isUrl } from '../support/files.js'
import { logger } from '../support/logger.js'
import { plural, slug } from '../support/str.js'
import { Rule, validate } from '../support/validation.js'

function routeId(req: Request, name: string): number | null {
    const value = Number(req.params[name])
    return Number.isInteger(value) ? value : null
}

const MOD_MESSAGES = {
    'name.required': 'You must fill in a mod slug name.',
    'pretty_name.required': 'You must enter in a mod name',
    'link.url': 'You must enter a properly formatted Website',
}

async function findMod(req: Request): Promise<Mod | null> {
    const id = routeId(req, 'mod_id')
    return id === null ? null : db.mod.findUnique({ where: { id } })
}

/** Hash a mod version's zip in the repository, retrying remote downloads */
async function modMd5(mod: Mod, version: string): Promise<{ success: true; md5: string; filesize: number } | { success: false; message: string }> {
    const location = config.solder.repo_location
    const uri = `${location}mods/${mod.name}/${mod.name}-${version}.zip`
    if (isUrl(uri)) {
        let result
        let attempts = 0
        do {
            result = await remoteMd5(uri)
            if (!result.success) {
                logger.warn(`Error attempting to remote MD5 file ${mod.name} version ${version} located at ${uri}.`)
            }
            attempts++
        } while (attempts < 3 && !result.success)
        return result
    }
    if (isFile(uri)) {
        logger.info(`Found '${uri}'`)
        try {
            return { success: true, md5: await hashFile(uri), filesize: fileSize(uri) }
        } catch (error) {
            logger.error(`Error attempting to md5 the file: ${uri}`)
            return { success: false, message: (error as Error).message }
        }
    }
    const error = `${uri} does not exist`
    logger.error(error)
    return { success: false, message: error }
}

function uploadResponse(redirect: Redirect, result: UploadResult): void {
    if (result.created.length > 0) {
        redirect.with('success', `Added ${result.created.map((created) => `${created.mod} ${created.version}`).join(', ')}.`)
    }
    if (result.errors.length > 0) {
        redirect.withErrors(result.errors)
    }
    redirect.send()
}

@Controller('mod')
@UseGuards(AuthGuard)
export class ModController {
    @Get()
    index(@Req() req: Request, @Res() res: Response): void {
        Web.of(req, res).redirect('mod/list').send()
    }

    @Get('list')
    async list(@Req() req: Request, @Res() res: Response): Promise<void> {
        authorize(req.user, Policies.mod.viewAny())
        const mods = await db.mod.findMany({ orderBy: { id: 'asc' } })
        const versions = await versionsForMods(mods.map((mod) => mod.id))
        await Web.of(req, res).view('mod.list', {
            mods: mods.map((mod) => ({ ...mod, latestVersion: latestOf(versions.get(mod.id) ?? []) })),
        })
    }

    @Get('view/:mod_id')
    async view(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const mod = await findMod(req)
        if (!mod) {
            web.redirect('mod/list').withErrors(['Mod not found']).send()
            return
        }
        authorize(req.user, Policies.mod.update())
        const versions = await versionsForMod(mod.id)
        const builds = await buildsForModversions(versions.map((version) => version.id))
        const modpacks = await modpacksByIds([...builds.values()].flat().map((build) => build.modpack_id))
        const permission = web.user.permission
        await web.view('mod.view', {
            mod: {
                ...mod,
                versions: versions.map((version) => ({
                    ...version,
                    builds: (builds.get(version.id) ?? []).filter((build) => modpacks.has(build.modpack_id)).map((build) => ({ ...build, modpack: modpacks.get(build.modpack_id) })),
                })),
            },
            accessibleModpackIds: permission?.solder_full ? null : modpackIds(permission),
        })
    }

    @Get('create')
    async create(@Req() req: Request, @Res() res: Response): Promise<void> {
        authorize(req.user, Policies.mod.create())
        await Web.of(req, res).view('mod.create')
    }

    @Post('create')
    async store(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        authorize(req.user, Policies.mod.create())
        const result = await validate(
            web.all(),
            { name: 'required|unique:mods', pretty_name: 'required', link: 'nullable|url' },
            { ...MOD_MESSAGES, 'name.unique': 'The slug you entered is already taken' },
        )
        if (!result.passes) {
            web.redirect('mod/create').withErrors(result.errors).send()
            return
        }
        const mod = await db.mod.create({
            data: {
                name: slug(web.string('name')),
                pretty_name: web.string('pretty_name'),
                author: web.input<string>('author'),
                description: web.input<string>('description'),
                link: web.input<string>('link'),
                notes: web.input<string>('notes'),
            },
        })
        await Cache.forget('mods')
        web.redirect(`mod/view/${mod.id}`).send()
    }

    @Get('import{/:provider}{/:query}')
    async import(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        authorize(req.user, Policies.mod.create())
        const all = providers()
        const provider = web.query('provider', (req.params.provider as string | undefined) ?? '') || Object.keys(all)[0]
        const query = web.query('query', (req.params.query as string | undefined) ?? '') ?? ''
        const gameVersion = web.query('game_version', '') ?? ''
        const releaseType = web.query('release_type', 'release') ?? 'release'
        const loader = web.query('loader', '') ?? ''
        const page = Math.max(1, Number.parseInt(web.query('page', '1') ?? '1', 10) || 1)
        let search = emptySearch()
        let errors: Record<string, string> = {}
        if (!Object.hasOwn(all, provider)) {
            errors.invalid_provider = 'Invalid provider specified'
        } else {
            search = await all[provider].search(query, page, gameVersion, loader)
            errors = { ...errors, ...(search.errors ?? {}) }
        }
        // Errors flashed by a redirect here are shown along with the search's own
        const flashed = (req.flash.errors as Record<string, string[]> | undefined) ?? {}
        const bag: Record<string, string[]> = { ...flashed }
        for (const [key, message] of Object.entries(errors)) {
            bag[key] = [...(bag[key] ?? []), message]
        }
        await web.view(
            'mod.import',
            { providers: all, provider, query, gameVersion, releaseType, loader, mods: search.mods, pagination: search.pagination },
            200,
            bag,
        )
    }

    @Get('import/details/:provider/:mod_id')
    async importDetails(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        authorize(req.user, Policies.mod.create())
        const provider = providers()[req.params.provider as string]
        if (!Object.hasOwn(providers(), req.params.provider as string)) {
            web.redirect('mod/import').withErrors({ invalid_provider: 'Invalid provider selected' }).send()
            return
        }
        const gameVersion = web.query('game_version', '') ?? ''
        const loader = web.query('loader', '') ?? ''
        const mod = await provider.modFor(req.params.mod_id as string, gameVersion, loader)
        if (mod === null) {
            web.redirect(`mod/import?provider=${encodeURIComponent(req.params.provider as string)}`)
                .withErrors({ mod_not_found: `Could not load that mod from ${provider.displayName()}.` })
                .send()
            return
        }
        await web.view('mod.import_details', { mod, provider: req.params.provider, providerName: provider.displayName(), gameVersion, loader })
    }

    @Post('import/details/:provider/:mod_id')
    async installFromDetails(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        authorize(req.user, Policies.mod.create())
        const key = req.params.provider as string
        const modId = req.params.mod_id as string
        const detailsUrl = `mod/import/details/${key}/${modId}`
        if (!Object.hasOwn(providers(), key)) {
            web.redirect('mod/import').withErrors({ invalid_provider: 'Invalid provider selected' }).send()
            return
        }
        const provider = providers()[key]
        const versions: string[] = []
        for (const encoded of web.array('versions')) {
            const text = String(encoded)
            if (/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
                versions.push(Buffer.from(text, 'base64').toString('utf8'))
            }
        }
        if (versions.length === 0) {
            web.redirect(detailsUrl).withErrors({ no_versions: 'Select at least one version to import' }).send()
            return
        }
        const gameVersion = web.string('game_version')
        const loader = web.string('loader')
        const modData = await provider.modFor(modId, gameVersion, loader)
        if (modData === null) {
            web.redirect(detailsUrl).withErrors({ mod_not_found: 'Mod or versions could not be loaded' }).send()
            return
        }
        if (versions.some((version) => !modData.versions.has(version))) {
            web.redirect(detailsUrl).withErrors({ invalid_versions: 'Invalid versions specified' }).send()
            return
        }
        const result = web.boolean('with_dependencies')
            ? await provider.installWithDependencies(modId, versions, modData, gameVersion, loader)
            : await provider.install(modId, versions, modData)
        if (!result.success) {
            web.redirect(detailsUrl).withErrors(result.errors).send()
            return
        }
        const message = [
            result.created ? `Imported ${result.created} ${plural('version', result.created)}. ` : '',
            result.existing ? `${result.existing} ${plural('version', result.existing)} already existed. ` : '',
            result.dependencies.length > 0 ? `Also imported required mods: ${result.dependencies.join(', ')}.` : '',
        ]
            .join('')
            .trim()
        const redirect = web.redirect(`mod/view/${result.id}`)
        if (message !== '') {
            redirect.with('success', message)
        }
        if (result.errors.length > 0) {
            redirect.withErrors(result.errors)
        }
        redirect.send()
    }

    @Post('import/batch')
    async importBatch(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        authorize(req.user, Policies.mod.create())
        const all = providers()
        const key = web.string('provider')
        const gameVersion = web.string('game_version')
        const releaseType = web.string('release_type', 'release') || 'release'
        const loader = web.string('loader')
        const modIds = web.array('mods').filter((id) => ['string', 'number', 'boolean'].includes(typeof id)).map(String)
        if (!Object.hasOwn(all, key)) {
            web.back().withErrors({ invalid_provider: 'Invalid provider selected' }).send()
            return
        }
        if (modIds.length === 0) {
            web.back().withErrors({ no_mods: 'No mods selected for import' }).send()
            return
        }
        const provider = all[key]
        const errors: string[] = []
        let importedCount = 0
        const dependencies: string[] = []
        const withDependencies = web.boolean('with_dependencies')
        // Shared across the batch so a library several mods need is only imported once
        const visited = new Set(modIds)
        for (const modId of modIds) {
            const modData = await provider.modFor(modId, gameVersion, loader)
            if (!modData || modData.versions.size === 0) {
                errors.push(`Could not load versions for mod ID: ${modId}`)
                continue
            }
            const version = latestStableVersionForGame(modData.versions, gameVersion, releaseType, loader)
            if (version === null) {
                const typePart = releaseType !== '' && releaseType !== 'any' ? ` ${releaseType}` : ''
                const gamePart = gameVersion !== '' ? ` for ${gameVersion}` : ''
                const loaderPart = loader !== '' ? ` (${loader})` : ''
                errors.push(`No${typePart} version found for ${modData.name}${gamePart}${loaderPart}`)
                continue
            }
            const result = withDependencies
                ? await provider.installWithDependencies(modId, [version], modData, gameVersion, loader, 3, visited)
                : await provider.install(modId, [version], modData)
            if (result.modversionIds.has(version)) {
                importedCount++
            }
            errors.push(...result.errors)
            dependencies.push(...result.dependencies)
        }
        const filters = Object.fromEntries(
            Object.entries({ provider: key, game_version: gameVersion, release_type: releaseType, loader }).filter(([, value]) => value !== ''),
        )
        const redirect = web.redirect(`mod/import?${new URLSearchParams(filters)}`)
        if (importedCount > 0) {
            redirect.with(
                'success',
                `${importedCount} ${plural('mod', importedCount)} imported successfully. ${dependencies.length > 0 ? `Also imported required mods: ${dependencies.join(', ')}.` : ''}`.trim(),
            )
        }
        if (errors.length > 0) {
            redirect.withErrors(errors)
        }
        redirect.send()
    }

    /** Mark a mod version as client-only, server-only, or needed on both sides */
    @Post('version-environment/:version_id')
    async versionEnvironment(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        authorize(req.user, Policies.modversion.update())
        const id = routeId(req, 'version_id')
        const modversion = id === null ? null : await db.modversion.findUnique({ where: { id } })
        if (!modversion) {
            web.json({ status: 'error', reason: 'Mod version not found' }, 404)
            return
        }
        const environment = web.input<string>('environment') || null
        if (![null, CLIENT_ONLY, SERVER_ONLY].includes(environment)) {
            web.json({ status: 'error', reason: 'Unknown environment' }, 422)
            return
        }
        await db.modversion.update({ where: { id: modversion.id }, data: { environment } })
        web.json({ status: 'success', environment })
    }

    /** Mod versions that no build uses, for cleaning up */
    @Get('unused')
    async unused(@Req() req: Request, @Res() res: Response): Promise<void> {
        authorize(req.user, Policies.modversion.delete())
        const modversions = (await withMods(await db.modversion.findMany({ where: { id: { in: await unusedModversionIds() } } }))).sort((a, b) => {
            const byName = (a.mod.pretty_name || a.mod.name).toLowerCase().localeCompare((b.mod.pretty_name || b.mod.name).toLowerCase())
            return byName !== 0 ? byName : a.id - b.id
        })
        await Web.of(req, res).view('mod.unused', { modversions, isRemote: ModRepository.isRemote() })
    }

    /** Delete unused mod versions (the selected ones, or all of them) and optionally their files */
    @Post('unused')
    async deleteUnused(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        authorize(req.user, Policies.modversion.delete())
        // Re-checked here: a version added to a build since the page loaded is left alone
        let ids = await unusedModversionIds()
        if (!web.boolean('all')) {
            const selected = web.array('modversions').map(Number)
            ids = ids.filter((id) => selected.includes(id))
        }
        const deleteFiles = web.boolean('delete_files') && !ModRepository.isRemote()
        let deleted = 0
        let freed = 0
        for (const modversion of await withMods(await db.modversion.findMany({ where: { id: { in: ids } } }))) {
            if (deleteFiles) {
                const path = ModRepository.location(modversion)
                if (isFile(path)) {
                    freed += statSync(path).size
                    unlinkSync(path)
                }
                try {
                    if (readdirSync(dirname(path)).length === 0) {
                        rmdirSync(dirname(path))
                    }
                } catch {
                    // The folder is already gone
                }
            }
            await db.modversion.delete({ where: { id: modversion.id } })
            deleted++
        }
        if (deleted === 0) {
            web.redirect('mod/unused').withErrors(['Select at least one unused version to delete.']).send()
            return
        }
        await Cache.forget('mods')
        let message = `Deleted ${deleted} unused mod ${plural('version', deleted)}`
        message += deleteFiles ? ` and freed ${formatFilesize(freed)}.` : '. Their files were kept in the repository.'
        web.redirect('mod/unused').with('success', message).send()
    }

    /** Create mods (or new versions of existing mods) from uploaded jars */
    @Post('upload')
    async upload(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        authorize(req.user, Policies.mod.create())
        const result = await validate(web.all(), { files: ['required', 'array', 'min:1'], 'files.*': ['file'] }, { 'files.required': 'Choose at least one .jar file to upload.' })
        if (!result.passes) {
            web.redirect('mod/list').withErrors(result.errors).send()
            return
        }
        const uploaded = await new ModUploadService().upload(web.files('files'))
        uploadResponse(uploaded.created.length === 1 ? web.redirect(`mod/view/${uploaded.created[0].mod_id}`) : web.redirect('mod/list'), uploaded)
    }

    /** Add uploaded files as new versions of a mod */
    @Post('upload/:mod_id')
    async uploadVersions(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const mod = await findMod(req)
        if (!mod) {
            web.redirect('mod/list').withErrors(['Mod not found']).send()
            return
        }
        authorize(req.user, Policies.modversion.create())
        const result = await validate(
            web.all(),
            { files: ['required', 'array', 'min:1'], 'files.*': ['file'], version: ['nullable', 'string', 'max:255'] },
            { 'files.required': 'Choose at least one file to upload.' },
        )
        if (!result.passes) {
            web.redirect(`mod/view/${mod.id}#versions`).withErrors(result.errors).send()
            return
        }
        uploadResponse(web.redirect(`mod/view/${mod.id}#versions`), await new ModUploadService().upload(web.files('files'), mod, web.input<string>('version')))
    }

    @Get('delete/:mod_id')
    async delete(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const mod = await findMod(req)
        if (!mod) {
            web.redirect('mod/list').withErrors(['Mod not found']).send()
            return
        }
        authorize(req.user, Policies.mod.delete())
        const versions = await versionsForMod(mod.id)
        const builds = await buildsForModversions(versions.map((version) => version.id))
        const modpacks = await modpacksByIds([...builds.values()].flat().map((build) => build.modpack_id))
        await web.view('mod.delete', {
            mod: {
                ...mod,
                versions: versions.map((version) => ({
                    ...version,
                    builds: (builds.get(version.id) ?? []).filter((build) => modpacks.has(build.modpack_id)).map((build) => ({ ...build, modpack: modpacks.get(build.modpack_id) })),
                })),
            },
        })
    }

    @Post('modify/:mod_id')
    async modify(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const mod = await findMod(req)
        if (!mod) {
            web.redirect('mod/list').withErrors(['Error modifying mod - Mod not found']).send()
            return
        }
        authorize(req.user, Policies.mod.update())
        const result = await validate(
            web.all(),
            { pretty_name: 'required', name: ['required', Rule.unique('mods', 'name').ignore(mod.id)], link: 'nullable|url' },
            { ...MOD_MESSAGES, 'name.unique': 'The slug you entered is already in use by another mod' },
        )
        if (!result.passes) {
            web.redirect(`mod/view/${mod.id}`).withErrors(result.errors).send()
            return
        }
        const updated = await db.mod.update({
            where: { id: mod.id },
            data: {
                pretty_name: web.string('pretty_name'),
                name: web.string('name'),
                author: web.input<string>('author'),
                description: web.input<string>('description'),
                link: web.input<string>('link'),
                notes: web.input<string>('notes'),
            },
        })
        await Cache.forget(`mod:${updated.name}`, 'mods')
        web.redirect(`mod/view/${mod.id}`).with('success', 'Mod successfully edited.').send()
    }

    @Post('delete/:mod_id')
    async destroy(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const mod = await findMod(req)
        if (!mod) {
            web.redirect('mod/list').withErrors(['Error deleting mod - Mod not found']).send()
            return
        }
        authorize(req.user, Policies.mod.delete())
        for (const version of await versionsForMod(mod.id)) {
            await db.buildModversion.deleteMany({ where: { modversion_id: version.id } })
            await db.modversion.delete({ where: { id: version.id } })
        }
        await db.mod.delete({ where: { id: mod.id } })
        await Cache.forget(`mod:${mod.name}`, 'mods')
        web.redirect('mod/list').with('success', 'Mod deleted!').send()
    }

    @Post('rehash')
    async rehash(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        web.requireAjax()
        authorize(req.user, Policies.modversion.update())
        const versionId = web.input('version-id')
        if (versionId === null) {
            web.json({ status: 'error', reason: 'Missing Post Data' })
            return
        }
        const ver = Number.isInteger(Number(versionId)) ? await db.modversion.findUnique({ where: { id: Number(versionId) } }) : null
        if (!ver) {
            web.json({ status: 'error', reason: 'Could not pull mod version from database' })
            return
        }
        const md5 = typeof web.input('md5') === 'string' ? web.string('md5') : ''
        if (md5 !== '' && !/^[a-f0-9]{32}$/i.test(md5)) {
            web.json({ status: 'error', reason: 'Invalid MD5 hash format' })
            return
        }
        if (md5 !== '') {
            const updated = await db.modversion.update({ where: { id: ver.id }, data: { md5 } })
            web.json({ status: 'success', version_id: updated.id, md5: updated.md5, filesize: humanFilesize(updated) })
            return
        }
        const mod = await db.mod.findUniqueOrThrow({ where: { id: ver.mod_id } })
        const hashed = await modMd5(mod, ver.version)
        if (!hashed.success) {
            web.json({ status: 'error', reason: `MD5 hashing failed. ${hashed.message}` })
            return
        }
        const updated = await db.modversion.update({ where: { id: ver.id }, data: { filesize: hashed.filesize, md5: hashed.md5 } })
        web.json({ status: 'success', version_id: updated.id, md5: updated.md5, filesize: humanFilesize(updated) })
    }

    @Post('add-version')
    async addVersion(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        web.requireAjax()
        authorize(req.user, Policies.modversion.create())
        const modId = web.input('mod-id')
        const version = web.input<string>('add-version')
        if (!modId || !version) {
            web.json({ status: 'error', reason: 'Missing Post Data' })
            return
        }
        const mod = Number.isInteger(Number(modId)) ? await db.mod.findUnique({ where: { id: Number(modId) } }) : null
        if (!mod) {
            web.json({ status: 'error', reason: 'Could not pull mod from database' })
            return
        }
        if ((await db.modversion.count({ where: { mod_id: mod.id, version: String(version) } })) > 0) {
            web.json({ status: 'error', reason: 'That mod version already exists' })
            return
        }
        const md5 = typeof web.input('add-md5') === 'string' ? web.string('add-md5') : ''
        if (md5 !== '' && !/^[a-f0-9]{32}$/i.test(md5)) {
            web.json({ status: 'error', reason: 'Invalid MD5 hash format' })
            return
        }
        if (md5 !== '') {
            const created = await db.modversion.create({ data: { mod_id: mod.id, version: String(version), md5 } })
            web.json({ status: 'success', version: created.version, version_id: created.id, md5: created.md5, filesize: humanFilesize(created) })
            return
        }
        const hashed = await modMd5(mod, String(version))
        if (!hashed.success) {
            web.json({ status: 'error', reason: `MD5 hashing failed. ${hashed.message}` })
            return
        }
        const created = await db.modversion.create({ data: { mod_id: mod.id, version: String(version), filesize: hashed.filesize, md5: hashed.md5 } })
        web.json({ status: 'success', version: created.version, md5: created.md5, filesize: humanFilesize(created) })
    }

    @Post('update-version/:version_id')
    async updateVersion(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        web.requireAjax()
        authorize(req.user, Policies.modversion.update())
        const id = routeId(req, 'version_id')
        const ver = id === null ? null : await db.modversion.findUnique({ where: { id } })
        if (!ver) {
            web.json({ status: 'error', reason: 'Could not find mod version' })
            return
        }
        await db.modversion.update({ where: { id: ver.id }, data: { notes: web.input<string>('notes') } })
        const mod = await db.mod.findUnique({ where: { id: ver.mod_id } })
        if (mod) {
            await Cache.forget(`mod:${mod.name}`)
        }
        web.json({ status: 'success', version_id: ver.id })
    }

    @Post('delete-version/:version_id')
    async deleteVersion(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        web.requireAjax()
        authorize(req.user, Policies.modversion.delete())
        const id = routeId(req, 'version_id')
        const ver = id === null ? null : await db.modversion.findUnique({ where: { id } })
        if (!ver) {
            web.json({ status: 'error', reason: 'Could not pull mod version from database' })
            return
        }
        const inUse = await db.buildModversion.count({ where: { modversion_id: ver.id } })
        if (inUse > 0) {
            web.json({ status: 'error', reason: `This version is in use by ${inUse} build(s) and cannot be deleted.` })
            return
        }
        await db.modversion.delete({ where: { id: ver.id } })
        web.json({ status: 'success', version: ver.version, version_id: ver.id })
    }

    @Get('versions/:modSlug')
    async versions(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        web.requireAjax()
        const modSlug = req.params.modSlug as string
        const cached = await Cache.remember(`mod:${modSlug}`, 5 * MINUTE, async () => {
            const mod = await db.mod.findUnique({ where: { name: modSlug } })
            return mod ? { mod, versions: await versionsForMod(mod.id) } : null
        })
        if (!cached) {
            web.json({ status: 'error', reason: 'Unknown mod' })
            return
        }
        web.json({
            ...only(cached.mod, ['id', 'name', 'pretty_name', 'author', 'description', 'link']),
            versions: cached.versions.map((version) => version.version),
        })
    }
}

/** $mod->latestVersion: the most recently updated version */
function latestOf<T extends { updated_at: Date | null; id: number }>(versions: T[]): T | null {
    return versions.reduce<T | null>((latest, version) => {
        if (latest === null) {
            return version
        }
        const a = latest.updated_at?.getTime() ?? 0
        const b = version.updated_at?.getTime() ?? 0
        return b > a || (b === a && version.id > latest.id) ? version : latest
    }, null)
}

