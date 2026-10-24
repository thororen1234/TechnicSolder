import { createToken } from '../../src/auth/tokens.js'
import { config } from '../../src/config.js'
import { db } from '../../src/database/prisma.js'
import { modversionIdsForBuild } from '../../src/models/relations.js'
import { admin, bearerToken, client, makeUser, useSolder } from '../support/helpers.js'

describe('Write API', () => {
    useSolder()
    let token = ''
    beforeEach(async () => {
        token = await bearerToken(await admin())
    })
    const api = (asToken: string | undefined = token) => client({ token: asToken })
    const read = (path: string) => client().get(`/api/${path}`)

    it('needs a valid token', async () => {
        await client().postJson('/api/modpack', { name: 'Test', slug: 'test' }).expect(401)
        await client({ token: 'invalid-token' }).postJson('/api/modpack', { name: 'Test', slug: 'test' }).expect(401)
        await api().postJson('/api/modpack', { name: 'New Pack', slug: 'new-pack' }).expect(201)
    })

    describe('modpacks', () => {
        it('creates a modpack', async () => {
            await api().postJson('/api/modpack', { name: 'API Pack', slug: 'api-pack' }).expect(201)
            expect(await db.modpack.count({ where: { slug: 'api-pack' } })).toBe(1)
        })

        it('rejects a duplicate slug or missing fields', async () => {
            await api().postJson('/api/modpack', { name: 'Other', slug: 'testmodpack' }).expect(422)
            await api().postJson('/api/modpack', {}).expect(422)
        })

        it('updates a modpack', async () => {
            await api().put('/api/modpack/testmodpack', { name: 'Updated Name' }).expect(200)
            expect((await db.modpack.findUniqueOrThrow({ where: { id: 1 } })).name).toBe('Updated Name')
            await api().put('/api/modpack/nonexistent', { name: 'Test' }).expect(404)
        })

        it('deletes a modpack', async () => {
            await api().delete('/api/modpack/testmodpack').expect(200)
            expect(await db.modpack.count({ where: { slug: 'testmodpack' } })).toBe(0)
        })
    })

    describe('builds', () => {
        it('creates a build', async () => {
            await api()
                .postJson('/api/modpack/testmodpack/build', { version: '2.0.0', minecraft: '1.20.1', min_java: '1.8', java_runtime: 'java-runtime-delta', is_published: true })
                .expect(201)
            expect(await db.build.count({ where: { modpack_id: 1, version: '2.0.0' } })).toBe(1)
            expect((await read('modpack/testmodpack/2.0.0').expect(200)).body).toMatchObject({ java: '1.8', java_runtime: 'java-runtime-delta' })
        })

        it('rejects a duplicate version', async () => {
            await api().postJson('/api/modpack/testmodpack/build', { version: '1.0.0', minecraft: '1.20.1' }).expect(422)
        })

        it('keeps an omitted runtime and clears an explicit null, even after a cached read', async () => {
            await db.build.update({ where: { id: 1 }, data: { java_runtime: 'jre-legacy' } })
            const url = '/api/modpack/testmodpack/1.0.0'
            expect((await client().get(url).expect(200)).body.java_runtime).toBe('jre-legacy')
            await api().put(url, { minecraft: '1.21.0' }).expect(200)
            expect((await client().get(url).expect(200)).body).toMatchObject({ minecraft: '1.21.0', java_runtime: 'jre-legacy' })
            await api().put(url, { java_runtime: 'java-runtime-delta' }).expect(200)
            expect((await client().get(url).expect(200)).body).toMatchObject({ java: '1.7', java_runtime: 'java-runtime-delta' })
            await api().put(url, { java_runtime: null }).expect(200)
            expect((await client().get(url).expect(200)).body).toMatchObject({ java: '1.7', java_runtime: null })
        })

        it.each([['java-runtime-unknown'], [['java-runtime-delta']], ['../../bin/java']])('rejects the runtime %j without changing anything', async (runtime) => {
            await db.build.update({ where: { id: 1 }, data: { java_runtime: 'java-runtime-gamma' } })
            const url = '/api/modpack/testmodpack/1.0.0'
            const create = await api().postJson('/api/modpack/testmodpack/build', { version: 'invalid-runtime', minecraft: '1.20.1', java_runtime: runtime }).expect(422)
            expect(create.body.error).toHaveProperty('java_runtime')
            expect(await db.build.count({ where: { modpack_id: 1, version: 'invalid-runtime' } })).toBe(0)
            const update = await api().put(url, { minecraft: '1.21.0', java_runtime: runtime }).expect(422)
            expect(update.body.error).toHaveProperty('java_runtime')
            expect(await db.build.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({ minecraft: '1.7.10', java_runtime: 'java-runtime-gamma' })
            expect((await client().get(url).expect(200)).body).toMatchObject({ minecraft: '1.7.10', java: '1.7', java_runtime: 'java-runtime-gamma' })
        })

        it('deletes a build', async () => {
            await api().delete('/api/modpack/testmodpack/1.0.0').expect(200)
            expect(await db.build.count({ where: { id: 1 } })).toBe(0)
        })

        it('clones a build', async () => {
            await db.build.update({ where: { id: 1 }, data: { java_runtime: 'java-runtime-delta' } })
            await api().postJson('/api/modpack/testmodpack/build', { version: '2.0.0', minecraft: '1.20.1', clone_from: '1.0.0', is_published: true }).expect(201)
            const newBuild = await db.build.findFirstOrThrow({ where: { version: '2.0.0', modpack_id: 1 } })
            expect(await modversionIdsForBuild(newBuild.id)).toHaveLength((await modversionIdsForBuild(1)).length)
            expect((await read('modpack/testmodpack/2.0.0').expect(200)).body.java_runtime).toBeNull()
        })

        it('clones a build of another modpack', async () => {
            const target = await db.modpack.create({ data: { name: 'Target Pack', slug: 'target-pack' } })
            await api().postJson('/api/modpack/target-pack/build', { version: '1.0.0', minecraft: '1.20.1', clone_from: '1.0.0', clone_from_modpack: 'testmodpack' }).expect(201)
            const newBuild = await db.build.findFirstOrThrow({ where: { version: '1.0.0', modpack_id: target.id } })
            expect(await modversionIdsForBuild(newBuild.id)).toHaveLength((await modversionIdsForBuild(1)).length)
        })

        it('refuses to clone from a modpack the token cannot access', async () => {
            const target = await db.modpack.create({ data: { name: 'Restricted Target', slug: 'restricted-target' } })
            const restricted = await makeUser({ modpacks_create: true, modpacks_manage: true, modpacks: [target.id] })
            const response = await api(await bearerToken(restricted))
                .postJson('/api/modpack/restricted-target/build', { version: '1.0.0', minecraft: '1.20.1', clone_from: '1.0.0', clone_from_modpack: 'testmodpack' })
                .expect(403)
            expect(response.body).toEqual({ error: 'You do not have permission to clone from that modpack.' })
        })
    })

    describe('build mods', () => {
        it('adds a mod to a build', async () => {
            await db.build.create({ data: { modpack_id: 1, version: '3.0.0', minecraft: '1.20.1' } })
            await api().postJson('/api/modpack/testmodpack/3.0.0/mod', { mod_slug: 'testmod', mod_version: '1.0' }).expect(201)
        })

        it('reports an unknown mod', async () => {
            await api().postJson('/api/modpack/testmodpack/1.0.0/mod', { mod_slug: 'nonexistent-mod', mod_version: '1.0.0' }).expect(404)
        })

        it('removes a mod from a build', async () => {
            await api().delete('/api/modpack/testmodpack/1.0.0/mod/testmod').expect(200)
        })
    })

    describe('mods', () => {
        it('creates a mod', async () => {
            await api().postJson('/api/mod', { name: 'new-api-mod', pretty_name: 'New API Mod', notes: 'API note' }).expect(201)
            expect(await db.mod.count({ where: { name: 'new-api-mod', notes: 'API note' } })).toBe(1)
        })

        it('rejects a duplicate mod', async () => {
            await api().postJson('/api/mod', { name: 'testmod', pretty_name: 'Duplicate' }).expect(422)
        })

        it('updates and deletes a mod', async () => {
            await api().put('/api/mod/testmod', { pretty_name: 'Updated Pretty Name' }).expect(200)
            expect((await db.mod.findUniqueOrThrow({ where: { id: 1 } })).pretty_name).toBe('Updated Pretty Name')
            await api().delete('/api/mod/testmod').expect(200)
            expect(await db.mod.count({ where: { name: 'testmod' } })).toBe(0)
        })

        it('keeps notes out of the read API', async () => {
            await db.mod.create({ data: { name: 'notes-test-mod', pretty_name: 'Notes Test Mod', notes: 'Secret internal note' } })
            config.solder.disable_mod_api = false
            expect((await read('mod/notes-test-mod').expect(200)).body).not.toHaveProperty('notes')
        })
    })

    describe('mod versions', () => {
        it('creates a version and rejects a duplicate', async () => {
            await api().postJson('/api/mod/testmod/version', { version: '2.0.0', md5: 'abc123def456' }).expect(201)
            await api().postJson('/api/mod/testmod/version', { version: '1.0', md5: 'abc123' }).expect(422)
        })

        it('refuses to delete a version in use', async () => {
            const response = await api().delete('/api/mod/testmod/1.0').expect(409)
            expect(response.body).toEqual({ error: 'Mod version is in use by 1 build(s) and cannot be deleted.' })
        })

        it('deletes a version', async () => {
            await db.buildModversion.deleteMany({ where: { modversion_id: 1 } })
            await api().delete('/api/mod/testmod/1.0').expect(200)
        })
    })

    describe('tokens', () => {
        it('creates, lists and revokes tokens', async () => {
            const created = await api().postJson('/api/token', { name: 'NewToken' }).expect(201)
            expect(Object.keys(created.body.token)).toEqual(['id', 'name', 'plaintext', 'created_at'])
            expect((await api().get('/api/token').expect(200)).body).toHaveProperty('tokens')
            const toRevoke = await createToken(await admin(), 'to-revoke')
            await api().delete(`/api/token/${toRevoke.accessToken.id}`).expect(200)
        })
    })

    describe('clients', () => {
        it('creates, updates and deletes a client', async () => {
            await api().postJson('/api/client', { name: 'API Client', uuid: 'api-client-uuid-12345' }).expect(201)
            await api().put('/api/client/2ezf6f26-eb15-4ccb-9f0b-8z5ed2c72946', { modpacks: [1] }).expect(200)
            await api().delete('/api/client/2ezf6f26-eb15-4ccb-9f0b-8z5ed2c72946').expect(200)
            expect(await db.client.count({ where: { uuid: '2ezf6f26-eb15-4ccb-9f0b-8z5ed2c72946' } })).toBe(0)
        })
    })

    it('keeps the read endpoints working', async () => {
        await read('').expect(200)
        await read('modpack').expect(200)
        const key = await db.key.findFirstOrThrow()
        await read(`modpack?k=${key.api_key}`).expect(200)
    })
})
