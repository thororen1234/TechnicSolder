import { db } from '../../src/database/prisma.js'
import { appUrl, route } from '../../src/http/urls.js'
import { Modrinth } from '../../src/mods/providers/modrinth.js'
import type { Build, Modpack, Modversion } from '../../src/models/types.js'
import { Http } from '../../src/support/http.js'
import { ZipReader } from '../../src/support/zip.js'
import {
    actingAs,
    admin,
    binary,
    expectSee,
    fakeFabricMeta,
    flashed,
    flashedErrors,
    makeFabricJar,
    putModversionZip,
    redirectPath,
    useModRepository,
    useSolder,
} from '../support/helpers.js'

describe('Build updates', () => {
    useSolder()
    useModRepository()
    let modpack: Modpack
    let build: Build

    async function addToBuild(modName: string, version: string, source: Partial<Modversion>): Promise<Modversion> {
        const mod = (await db.mod.findUnique({ where: { name: modName } })) ?? (await db.mod.create({ data: { name: modName, pretty_name: modName[0].toUpperCase() + modName.slice(1) } }))
        const modversion = await db.modversion.create({ data: { mod_id: mod.id, version, md5: 'x', ...source } })
        await db.buildModversion.create({ data: { build_id: build.id, modversion_id: modversion.id } })
        return modversion
    }

    beforeEach(async () => {
        modpack = await db.modpack.create({ data: { name: 'Update Pack', slug: 'update-pack' } })
        build = await db.build.create({ data: { modpack_id: modpack.id, version: '1.0.0', minecraft: '1.20.1' } })
        await addToBuild('fabric-loader', '1.20.1-0.14.9', { provider: 'fabric', provider_project_id: '1.20.1', provider_version_id: '1.20.1-0.14.9' })
        await addToBuild('sodium', '1.20.1-0.5.0', { provider: 'modrinth', provider_project_id: 'AANobbMI', provider_version_id: 'v1' })
        await addToBuild('handmade', '1.0', {})
        fakeFabricMeta()
    })

    /** Modrinth version ID => mod version, newest first */
    function fakeSodiumVersions(versions: Record<string, string>): void {
        const fakes: Parameters<typeof Http.fake>[0] = {
            'api.modrinth.com/v2/project/AANobbMI': { body: { id: 'AANobbMI', slug: 'sodium', title: 'Sodium', project_type: 'mod' } },
            'api.modrinth.com/v2/project/AANobbMI/members': { body: [] },
            'api.modrinth.com/v2/project/AANobbMI/version*': {
                body: Object.entries(versions).map(([id, number]) => ({
                    id,
                    version_number: number,
                    version_type: 'release',
                    game_versions: ['1.20.1'],
                    loaders: ['fabric'],
                    files: [{ url: `https://cdn.modrinth.com/data/AANobbMI/versions/${id}/sodium.jar`, filename: 'sodium.jar', primary: true }],
                })),
            },
        }
        for (const [id, number] of Object.entries(versions)) {
            fakes[`cdn.modrinth.com/data/AANobbMI/versions/${id}/sodium.jar`] = { body: makeFabricJar('sodium', number) }
        }
        Http.fake(fakes)
    }

    async function modVersions(of: Build): Promise<Record<string, string>> {
        const links = await db.buildModversion.findMany({ where: { build_id: of.id } })
        const modversions = await db.modversion.findMany({ where: { id: { in: links.map((link) => link.modversion_id) } } })
        const mods = await db.mod.findMany({ where: { id: { in: modversions.map((mv) => mv.mod_id) } } })
        const entries = modversions.map((mv) => [mods.find((mod) => mod.id === mv.mod_id)!.name, mv.version] as const)
        return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)))
    }

    const sentUrls = () => Http.recorded().map((request) => decodeURIComponent(request.url))
    const json = { headers: { Accept: 'application/json' } }

    it('records where each imported version came from', async () => {
        fakeSodiumVersions({ v2: '0.5.1', v1: '0.5.0' })
        const result = await Modrinth.install('AANobbMI', ['v2'])
        const modversion = await db.modversion.findUniqueOrThrow({ where: { id: result.modversionIds.get('v2') } })
        expect(modversion).toMatchObject({ provider: 'modrinth', provider_project_id: 'AANobbMI', provider_version_id: 'v2' })
    })

    it('records the source when reimporting an untracked version', async () => {
        fakeSodiumVersions({ v2: '0.5.1', v1: '0.5.0' })
        const sodium = await db.mod.findUniqueOrThrow({ where: { name: 'sodium' } })
        const handmade = await db.modversion.create({ data: { mod_id: sodium.id, version: '1.20.1-0.5.1', md5: 'x' } })
        await Modrinth.install('AANobbMI', ['v2'])
        expect((await db.modversion.findUniqueOrThrow({ where: { id: handmade.id } })).provider_version_id).toBe('v2')
    })

    it('lists newer versions of tracked mods only', async () => {
        fakeSodiumVersions({ v2: '0.5.1', v1: '0.5.0' })
        const response = await actingAs(await admin(), json).get(`/modpack/build/${build.id}/updates`).expect(200)
        const updates = response.body.updates as Record<string, unknown>[]
        expect(updates).toHaveLength(1)
        expect(updates[0]).toMatchObject({ mod: 'sodium', current: '1.20.1-0.5.0', latest_key: 'v2', latest_label: '0.5.1', provider: 'Modrinth' })
        expect(
            sentUrls().some((url) => url.includes('/project/AANobbMI/version?') && url.includes('game_versions=["1.20.1"]') && url.includes('loaders=["fabric"]')),
        ).toBe(true)
    })

    it('never offers an older version', async () => {
        // The build already has a beta that is newer than the latest release
        fakeSodiumVersions({ 'v3-beta': '0.6.0', v2: '0.5.1', v1: '0.5.0' })
        await db.modversion.updateMany({ where: { provider_version_id: 'v1' }, data: { provider_version_id: 'v3-beta' } })
        expect((await actingAs(await admin(), json).get(`/modpack/build/${build.id}/updates`).expect(200)).body).toEqual({ updates: [] })
    })

    it('creates a new build with the updates and keeps the old one', async () => {
        fakeSodiumVersions({ v2: '0.5.1', v1: '0.5.0' })
        const sodiumV1 = (await db.modversion.findFirstOrThrow({ where: { provider_version_id: 'v1' } })).id
        const response = await actingAs(await admin()).post(`/modpack/build/${build.id}/updates`, { version: '1.0.1', modversions: [sodiumV1] })

        const newBuild = await db.build.findFirstOrThrow({ where: { modpack_id: modpack.id, version: '1.0.1' } })
        expect(response.headers.location).toBe(appUrl(`modpack/build/${newBuild.id}`))
        expect(flashed(response).success).toBe('Build 1.0.1 created with 1 update.')
        expect(Boolean(newBuild.is_published)).toBe(false)
        expect(await modVersions(newBuild)).toEqual({ 'fabric-loader': '1.20.1-0.14.9', handmade: '1.0', sodium: '1.20.1-0.5.1' })
        expect(await modVersions(build)).toEqual({ 'fabric-loader': '1.20.1-0.14.9', handmade: '1.0', sodium: '1.20.1-0.5.0' })
    })

    it('offers compare, health and updates on the build page', async () => {
        // URLs are built from the request's host, so compare paths
        const path = (name: string) => new URL(route(name, build.id)).pathname
        const response = await actingAs(await admin()).get(`/modpack/build/${build.id}`).expect(200)
        expect(response.text).toContain(`${path('modpack.build.compare')}"`)
        // The status endpoints are embedded with js(), which escapes slashes
        expect(response.text).toContain(`${path('modpack.build.health').replaceAll('/', '\\/')}'`)
        expect(response.text).toContain(`${path('modpack.build.updates').replaceAll('/', '\\/')}'`)
        // Suggested version for the updated build
        expectSee(response, '1.0.1')
    })

    it('moves mods and the loader when copying to another Minecraft version', async () => {
        Http.fake({
            'api.modrinth.com/v2/project/AANobbMI': { body: { id: 'AANobbMI', slug: 'sodium', title: 'Sodium', project_type: 'mod' } },
            'api.modrinth.com/v2/project/AANobbMI/members': { body: [] },
            'api.modrinth.com/v2/project/AANobbMI/version*': {
                body: [
                    {
                        id: 'v26',
                        version_number: '0.7.0',
                        version_type: 'release',
                        game_versions: ['26.1'],
                        loaders: ['fabric'],
                        files: [{ url: 'https://cdn.modrinth.com/data/AANobbMI/versions/v26/sodium.jar', filename: 'sodium.jar', primary: true }],
                    },
                ],
            },
            'cdn.modrinth.com/data/AANobbMI/versions/v26/sodium.jar': { body: makeFabricJar('sodium', '0.7.0', '26.1') },
        })
        const response = await actingAs(await admin()).post(`/modpack/build/${build.id}/copy`, { version: '2.0.0', minecraft: '26.1' })

        const copy = await db.build.findFirstOrThrow({ where: { modpack_id: modpack.id, version: '2.0.0' } })
        expect(response.headers.location).toBe(appUrl(`modpack/build/${copy.id}`))
        expect(copy.minecraft).toBe('26.1')
        expect(Boolean(copy.is_published)).toBe(false)
        expect(await modVersions(copy)).toEqual({ 'fabric-loader': '26.1-0.14.9', handmade: '1.0', sodium: '26.1-0.7.0' })
        // Mods added by hand can't be checked, so the user is told
        expect(Object.values(flashedErrors(response))[0][0]).toContain('Handmade 1.0 was added by hand')
        expect(sentUrls().some((url) => url.includes('game_versions=["26.1"]'))).toBe(true)
    })

    it('needs a valid Minecraft version to copy', async () => {
        const response = await actingAs(await admin()).post(`/modpack/build/${build.id}/copy`, { version: '2.0.0', minecraft: 'latest' })
        expect(flashedErrors(response)).toHaveProperty('minecraft')
    })

    it('needs an unused version for the new build', async () => {
        const response = await actingAs(await admin()).post(`/modpack/build/${build.id}/updates`, { version: '1.0.0', modversions: [1] })
        expect(flashedErrors(response)).toHaveProperty('version')
        expect(await db.build.count({ where: { modpack_id: modpack.id } })).toBe(1)
    })

    it('lists tracked CurseForge mods in the manifest of a CurseForge export', async () => {
        await addToBuild('jei', '1.20.1-15.2.0', { provider: 'curseforge', provider_project_id: '238222', provider_version_id: '111' })
        putModversionZip('jei', '1.20.1-15.2.0', { 'mods/jei.jar': 'jar' })
        putModversionZip('handmade', '1.0', { 'mods/handmade.jar': 'jar' })
        putModversionZip('sodium', '1.20.1-0.5.0', { 'mods/sodium.jar': 'jar' })
        putModversionZip('fabric-loader', '1.20.1-0.14.9', { 'bin/version.json': '{}' })

        const response = await binary(actingAs(await admin()).get(`/modpack/build/${build.id}/export/curseforge`)).expect(200)
        const zip = ZipReader.open(response.body as Buffer)!
        expect((JSON.parse(zip.getText('manifest.json')!) as { files: unknown }).files).toEqual([{ projectID: 238222, fileID: 111, required: true }])
        expect(zip.locateName('overrides/mods/jei.jar')).toBe(false)
        expect(zip.locateName('overrides/mods/handmade.jar')).toBe(true)
    })

    it('redirects a signed-out visitor from the update check', async () => {
        expect(redirectPath(await actingAs(null as never).get(`/modpack/build/${build.id}/updates`))).toBe('/login')
    })
})
