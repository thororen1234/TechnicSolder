import { config } from '../../src/config.js'
import type { UserPermission } from '../../src/models/types.js'
import { bearerToken, client, makeUser, useSolder } from '../support/helpers.js'

type Permissions = Partial<Omit<UserPermission, 'id' | 'user_id' | 'modpacks'>> & { modpacks?: number[] }

describe('Write API authorization', () => {
    useSolder()
    const as = async (permissions: Permissions = {}) => client({ token: await bearerToken(await makeUser(permissions)) })

    it('needs a valid token', async () => {
        await client().postJson('/api/modpack', { name: 'Test', slug: 'test' }).expect(401)
        await client({ token: 'invalid' }).postJson('/api/modpack', { name: 'Test', slug: 'test' }).expect(401)
    })

    it.each<[string, Permissions, number]>([
        ['with modpacks_create', { modpacks_create: true }, 201],
        ['without permission', {}, 403],
        ['with solder_full', { solder_full: true }, 201],
        ['with only mod permissions', { mods_create: true, mods_manage: true, mods_delete: true }, 403],
    ])('creating a modpack %s', async (_name, permissions, status) => {
        await (await as(permissions)).postJson('/api/modpack', { name: 'Auth Pack', slug: 'auth-pack' }).expect(status)
    })

    it.each<[string, Permissions, number]>([
        ['with access', { modpacks_manage: true, modpacks: [1] }, 200],
        ['without access', { modpacks_manage: true }, 403],
        ['with solder_full', { solder_full: true }, 200],
    ])('updating a modpack %s', async (_name, permissions, status) => {
        await (await as(permissions)).put('/api/modpack/testmodpack', { name: 'Updated' }).expect(status)
    })

    it.each<[string, Permissions, number]>([
        ['with permission and access', { modpacks_delete: true, modpacks: [1] }, 200],
        ['without permission', {}, 403],
    ])('deleting a modpack %s', async (_name, permissions, status) => {
        await (await as(permissions)).delete('/api/modpack/testmodpack').expect(status)
    })

    it.each<[string, Permissions, number]>([
        ['with access', { modpacks_manage: true, modpacks: [1] }, 201],
        ['without access', { modpacks_manage: true }, 403],
    ])('creating a build %s', async (_name, permissions, status) => {
        await (await as(permissions)).postJson('/api/modpack/testmodpack/build', { version: '9.0.0', minecraft: '1.20.1' }).expect(status)
    })

    it('deleting a build without permission', async () => {
        await (await as()).delete('/api/modpack/testmodpack/1.0.0').expect(403)
    })

    describe('with the mod read API disabled', () => {
        beforeEach(() => {
            config.solder.disable_mod_api = true
        })

        it('lets mod managers read', async () => {
            const api = await as({ mods_manage: true })
            expect((await api.get('/api/mod').expect(200)).body.mods.testmod).toBe('TestMod')
            const mod = await api.get('/api/mod/testmod').expect(200)
            expect(mod.body).toMatchObject({ id: 1, name: 'testmod' })
            expect(mod.body).toHaveProperty('versions')
            const version = await api.get('/api/mod/testmod/1.0').expect(200)
            expect(version.body).toMatchObject({ id: 1, md5: 'bdbc6c6cc48c7b037e4aef64b58258a3' })
            expect(version.body).toHaveProperty('builds')
        })

        it('lets a superadmin read', async () => {
            expect((await (await as({ solder_full: true })).get('/api/mod').expect(200)).body).toHaveProperty('mods')
        })

        it('turns away everyone else', async () => {
            expect((await (await as()).get('/api/mod').expect(404)).body).toEqual({ error: 'Mod API has been disabled' })
        })

        it('still lets mod creators write', async () => {
            await (await as({ mods_create: true })).postJson('/api/mod', { name: 'auth-mod', pretty_name: 'Auth Mod' }).expect(201)
        })
    })

    it.each<[string, Permissions, number]>([
        ['without permission', {}, 403],
        ['with solder_full', { solder_full: true }, 201],
        ['with only modpack permissions', { modpacks_create: true, modpacks_manage: true }, 403],
        ['with only client permissions', { solder_clients: true }, 403],
    ])('creating a mod %s', async (_name, permissions, status) => {
        await (await as(permissions)).postJson('/api/mod', { name: 'auth-mod', pretty_name: 'Auth Mod' }).expect(status)
    })

    it.each<[string, Permissions, number]>([
        ['with permission', { mods_manage: true }, 200],
        ['without permission', {}, 403],
    ])('updating a mod %s', async (_name, permissions, status) => {
        await (await as(permissions)).put('/api/mod/testmod', { pretty_name: 'Updated' }).expect(status)
    })

    it.each<[string, Permissions, number]>([
        ['with permission', { mods_delete: true }, 200],
        ['without permission', {}, 403],
    ])('deleting a mod %s', async (_name, permissions, status) => {
        await (await as(permissions)).delete('/api/mod/testmod').expect(status)
    })

    it.each<[string, Permissions, number]>([
        ['with permission', { mods_manage: true }, 201],
        ['without permission', {}, 403],
    ])('creating a mod version %s', async (_name, permissions, status) => {
        await (await as(permissions)).postJson('/api/mod/testmod/version', { version: '9.0.0', md5: 'abc123' }).expect(status)
    })

    it.each<[string, Permissions, number]>([
        ['with permission', { solder_clients: true }, 201],
        ['without permission', {}, 403],
        ['with solder_full', { solder_full: true }, 201],
    ])('creating a client %s', async (_name, permissions, status) => {
        await (await as(permissions)).postJson('/api/client', { name: 'Auth Client', uuid: 'auth-client-uuid' }).expect(status)
    })

    it('deleting a client without permission', async () => {
        await (await as()).delete('/api/client/2ezf6f26-eb15-4ccb-9f0b-8z5ed2c72946').expect(403)
    })

    it('lets any user list and create their own tokens', async () => {
        const api = await as()
        await api.get('/api/token').expect(200)
        await api.postJson('/api/token', { name: 'My Token' }).expect(201)
    })
})
