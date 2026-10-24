import { config, SOLDER_STREAM, SOLDER_VERSION } from '../../src/config.js'
import { db } from '../../src/database/prisma.js'
import type { Modpack, Modversion } from '../../src/models/types.js'
import { Cache } from '../../src/support/cache.js'
import { admin, bearerToken, client, makeUser, useSolder } from '../support/helpers.js'

const getJson = (path: string, token?: string) => client({ token }).get(`/api/${path}`)

function makePrivateModpack(): Promise<Modpack> {
    return db.modpack.create({ data: { name: 'PrivatePack', slug: 'privatepack', hidden: true, private: true, icon_url: '', logo_url: '', background_url: '' } })
}

async function makeHiddenModpack(): Promise<Modpack> {
    const modpack = await db.modpack.create({ data: { name: 'HiddenPack', slug: 'hiddenpack', hidden: true, private: false, icon_url: '', logo_url: '', background_url: '' } })
    await db.build.create({ data: { modpack_id: modpack.id, version: '1.0.0', minecraft: '1.7.10', min_java: '1.7', min_memory: 1024, is_published: true } })
    return modpack
}

async function buildWith(modversion: Modversion, modpack: Modpack, version: string, attributes: { is_published?: boolean; private?: boolean } = {}) {
    const build = await db.build.create({ data: { modpack_id: modpack.id, version, is_published: true, private: false, ...attributes } })
    await db.buildModversion.create({ data: { build_id: build.id, modversion_id: modversion.id } })
    return build
}

const buildIds = (body: { builds: { id: number }[] }) => body.builds.map((build) => build.id)

describe('Launcher API', () => {
    useSolder()
    const testModversion = () => db.modversion.findFirstOrThrow({ where: { mod_id: 1 } })
    const publicModpack = () => db.modpack.findUniqueOrThrow({ where: { id: 1 } })

    it('describes itself', async () => {
        const response = await getJson('').expect(200)
        expect(response.body).toEqual({ api: 'TechnicSolder', version: SOLDER_VERSION, stream: SOLDER_STREAM })
    })

    it('lists modpacks', async () => {
        const response = await getJson('modpack').expect(200)
        expect(response.body).toHaveProperty('modpacks')
        expect(response.body).toHaveProperty('mirror_url')
    })

    it('lists mods unless the mod API is disabled', async () => {
        config.solder.disable_mod_api = false
        expect((await getJson('mod').expect(200)).body).toHaveProperty('mods')
        config.solder.disable_mod_api = true
        expect((await getJson('mod').expect(404)).body).toEqual({ error: 'Mod API has been disabled' })
    })

    it('reports an unknown modpack', async () => {
        expect((await getJson('modpack/bob').expect(404)).body).toEqual({ error: 'Modpack does not exist' })
    })

    it('describes a modpack', async () => {
        const response = await getJson('modpack/testmodpack').expect(200)
        for (const key of ['name', 'display_name', 'url', 'icon', 'icon_md5', 'latest', 'logo', 'logo_md5', 'recommended', 'background', 'background_md5', 'builds']) {
            expect(response.body).toHaveProperty(key)
        }
        expect(response.body.builds).toEqual(['1.0.0'])
    })

    it.each([
        ['mod/bob', 'Mod does not exist'],
        ['mod/foo/bar', 'Mod does not exist'],
        ['mod/testmod/invalid', 'Mod version does not exist'],
    ])('reports %s as missing unless the mod API is disabled', async (path, error) => {
        config.solder.disable_mod_api = false
        expect((await getJson(path).expect(404)).body).toEqual({ error })
        config.solder.disable_mod_api = true
        expect((await getJson(path).expect(404)).body).toEqual({ error: 'Mod API has been disabled' })
    })

    it('describes a mod', async () => {
        config.solder.disable_mod_api = false
        const response = await getJson('mod/testmod').expect(200)
        for (const key of ['name', 'pretty_name', 'author', 'description', 'link', 'versions']) {
            expect(response.body).toHaveProperty(key)
        }
        config.solder.disable_mod_api = true
        expect((await getJson('mod/testmod').expect(404)).body).toEqual({ error: 'Mod API has been disabled' })
    })

    it('describes a build', async () => {
        const response = await getJson('modpack/testmodpack/1.0.0').expect(200)
        for (const key of ['minecraft', 'forge', 'java', 'java_runtime', 'memory', 'mods']) {
            expect(response.body).toHaveProperty(key)
        }
        expect(response.body).toMatchObject({ java: '1.7', java_runtime: null })
    })

    it('hides a private build', async () => {
        await db.build.update({ where: { id: 1 }, data: { private: true } })
        expect((await getJson('modpack/testmodpack/1.0.0').expect(404)).body).toEqual({ error: 'Build does not exist' })
    })

    it('describes a mod version', async () => {
        config.solder.disable_mod_api = false
        const modversion = await testModversion()
        const response = await getJson('mod/testmod/1.0').expect(200)
        expect(response.body).toMatchObject({
            md5: modversion.md5,
            filesize: modversion.filesize,
            url: `${config.solder.mirror_url}mods/testmod/testmod-1.0.zip`,
        })
        config.solder.disable_mod_api = true
        expect((await getJson('mod/testmod/1.0').expect(404)).body).toEqual({ error: 'Mod API has been disabled' })
    })

    describe('builds of a mod version', () => {
        beforeEach(() => {
            config.solder.disable_mod_api = false
        })

        it('lists accessible builds with their modpack', async () => {
            const modpack = await publicModpack()
            const second = await buildWith(await testModversion(), modpack, '2.0.0')
            const response = await getJson('mod/testmod/1.0').expect(200)
            const modpackInfo = { id: modpack.id, name: modpack.slug, display_name: modpack.name }
            expect(response.body.builds).toEqual([
                { id: 1, version: '1.0.0', modpack: modpackInfo },
                { id: second.id, version: '2.0.0', modpack: modpackInfo },
            ])
        })

        it('hides unpublished and unauthorized builds', async () => {
            const modversion = await testModversion()
            const hidden = await makeHiddenModpack()
            const hiddenBuild = await buildWith(modversion, hidden, 'hidden-membership')
            await buildWith(modversion, await publicModpack(), 'private-membership', { private: true })
            await buildWith(modversion, await makePrivateModpack(), 'private-pack-membership')
            await buildWith(modversion, await publicModpack(), 'unpublished-membership', { is_published: false })
            const response = await getJson('mod/testmod/1.0').expect(200)
            expect(response.body.builds).toEqual([
                { id: 1, version: '1.0.0', modpack: { id: 1, name: 'testmodpack', display_name: 'TestModpack' } },
                { id: hiddenBuild.id, version: 'hidden-membership', modpack: { id: hidden.id, name: 'hiddenpack', display_name: 'HiddenPack' } },
            ])
        })

        it("respects a token user's modpack scope", async () => {
            const privatePack = await makePrivateModpack()
            const privateBuild = await buildWith(await testModversion(), privatePack, 'private-pack-membership')
            const scoped = await makeUser({ modpacks_manage: true, modpacks: [privatePack.id] })
            expect(buildIds((await getJson('mod/testmod/1.0', await bearerToken(scoped)).expect(200)).body)).toEqual([1, privateBuild.id])
            const unscoped = await makeUser({ modpacks_manage: true })
            expect(buildIds((await getJson('mod/testmod/1.0', await bearerToken(unscoped)).expect(200)).body)).toEqual([1])
            expect(buildIds((await getJson('mod/testmod/1.0', await bearerToken(await admin())).expect(200)).body)).toEqual([1, privateBuild.id])
        })

        it('respects client and platform key access', async () => {
            const modversion = await testModversion()
            const associated = await makePrivateModpack()
            const unassociated = await makeHiddenModpack()
            await db.modpack.update({ where: { id: unassociated.id }, data: { private: true } })
            const associatedBuild = await buildWith(modversion, associated, 'associated-private-membership')
            const unassociatedBuild = await buildWith(modversion, unassociated, 'unassociated-private-membership')
            const testClient = await db.client.findFirstOrThrow()
            await db.clientModpack.create({ data: { client_id: testClient.id, modpack_id: associated.id } })
            expect(buildIds((await getJson(`mod/testmod/1.0?cid=${testClient.uuid}`).expect(200)).body)).toEqual([1, associatedBuild.id])
            const key = await db.key.findFirstOrThrow()
            expect(buildIds((await getJson(`mod/testmod/1.0?k=${key.api_key}`).expect(200)).body)).toEqual([1, associatedBuild.id, unassociatedBuild.id])
        })

        it('rechecks visibility after a cached authorized request', async () => {
            const privateBuild = await buildWith(await testModversion(), await makePrivateModpack(), 'private-cached-membership')
            const key = await db.key.findFirstOrThrow()
            expect(buildIds((await getJson(`mod/testmod/1.0?k=${key.api_key}`).expect(200)).body)).toEqual([1, privateBuild.id])
            expect(buildIds((await getJson('mod/testmod/1.0').expect(200)).body)).toEqual([1])
        })
    })

    describe('private and hidden modpacks', () => {
        it('are listed for users who can access them', async () => {
            const modpack = await makePrivateModpack()
            expect((await getJson('modpack', await bearerToken(await admin())).expect(200)).body.modpacks).toHaveProperty('privatepack', 'PrivatePack')
            const scoped = await makeUser({ modpacks_manage: true, modpacks: [modpack.id] })
            expect((await getJson('modpack', await bearerToken(scoped)).expect(200)).body.modpacks).toHaveProperty('privatepack', 'PrivatePack')
            const unscoped = await makeUser({ modpacks_manage: true })
            expect((await getJson('modpack', await bearerToken(unscoped)).expect(200)).body.modpacks).not.toHaveProperty('privatepack')
            expect((await getJson('modpack').expect(200)).body.modpacks).not.toHaveProperty('privatepack')
        })

        it('can only be opened by users who can access them', async () => {
            const modpack = await makePrivateModpack()
            expect((await getJson('modpack/privatepack').expect(404)).body).toEqual({ error: 'Modpack does not exist' })
            const scoped = await makeUser({ modpacks_manage: true, modpacks: [modpack.id] })
            expect((await getJson('modpack/privatepack', await bearerToken(scoped)).expect(200)).body.name).toBe('privatepack')
        })

        it('hide their builds from guests, even after a cached authorized request', async () => {
            const modpack = await makePrivateModpack()
            await db.build.create({ data: { modpack_id: modpack.id, version: '1.0.0', minecraft: '1.7.10', min_java: '1.7', min_memory: 1024, is_published: true } })
            expect((await getJson('modpack/privatepack/1.0.0').expect(404)).body).toEqual({ error: 'Modpack does not exist' })
            const authorized = await getJson('modpack/privatepack/1.0.0', await bearerToken(await admin())).expect(200)
            expect(authorized.body).toHaveProperty('minecraft')
            expect(authorized.body).toHaveProperty('mods')
            expect((await getJson('modpack/privatepack/1.0.0').expect(404)).body).toEqual({ error: 'Modpack does not exist' })
        })

        it('stay private after a cached authorized request', async () => {
            await makePrivateModpack()
            expect((await getJson('modpack/privatepack', await bearerToken(await admin())).expect(200)).body.name).toBe('privatepack')
            expect((await getJson('modpack/privatepack').expect(404)).body).toEqual({ error: 'Modpack does not exist' })
        })

        it('are left out of the listing when hidden, but can be opened directly', async () => {
            await makeHiddenModpack()
            expect((await getJson('modpack').expect(200)).body.modpacks).not.toHaveProperty('hiddenpack')
            const modpack = await getJson('modpack/hiddenpack').expect(200)
            expect(modpack.body).toMatchObject({ name: 'hiddenpack', display_name: 'HiddenPack', builds: ['1.0.0'] })
            const build = await getJson('modpack/hiddenpack/1.0.0').expect(200)
            for (const key of ['minecraft', 'forge', 'java', 'memory', 'mods']) {
                expect(build.body).toHaveProperty(key)
            }
        })
    })

    describe('private builds', () => {
        beforeEach(async () => {
            await db.build.update({ where: { id: 1 }, data: { private: true } })
        })

        it('are shown to users who can access the modpack', async () => {
            expect((await getJson('modpack/testmodpack/1.0.0', await bearerToken(await admin())).expect(200)).body).toHaveProperty('mods')
            const scoped = await makeUser({ modpacks_manage: true, modpacks: [1] })
            const token = await bearerToken(scoped)
            expect((await getJson('modpack/testmodpack/1.0.0', token).expect(200)).body).toHaveProperty('mods')
            expect((await getJson('modpack/testmodpack', token).expect(200)).body.builds).toEqual(['1.0.0'])
        })

        it('are hidden from users who cannot', async () => {
            const token = await bearerToken(await makeUser({ modpacks_manage: true }))
            expect((await getJson('modpack/testmodpack/1.0.0', token).expect(404)).body).toEqual({ error: 'Build does not exist' })
            expect((await getJson('modpack/testmodpack', token).expect(200)).body.builds).toEqual([])
        })
    })

    describe('mod notes', () => {
        beforeEach(async () => {
            config.solder.disable_mod_api = false
            await db.mod.update({ where: { id: 1 }, data: { notes: 'Admin-only note' } })
            await Cache.forget('mod:testmod')
        })

        it('are shown to an admin with a token', async () => {
            expect((await getJson('mod/testmod', await bearerToken(await admin())).expect(200)).body.notes).toBe('Admin-only note')
        })

        it('are hidden from guests and unprivileged users', async () => {
            expect((await getJson('mod/testmod').expect(200)).body).not.toHaveProperty('notes')
            const viewer = await makeUser({ solder_full: false, mods_manage: false })
            expect((await getJson('mod/testmod', await bearerToken(viewer)).expect(200)).body).not.toHaveProperty('notes')
        })
    })
})
