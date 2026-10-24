import { db } from '../../src/database/prisma.js'
import { clientsForModpack } from '../../src/models/relations.js'
import { actingAs, admin, flashed, flashedErrors, redirectPath, useSolder } from '../support/helpers.js'

describe('Modpacks', () => {
    useSolder()
    const as = async (ajax = false) => actingAs(await admin(), { ajax })

    it('redirects the index to the list', async () => {
        expect(redirectPath(await (await as()).get('/modpack'))).toBe('/modpack/list')
    })

    it('lists modpacks', async () => {
        await (await as()).get('/modpack/list').expect(200)
    })

    it('falls back to the default icon when an icon fails to load', async () => {
        const modpack = await db.modpack.create({ data: { name: 'Moved Pack', slug: 'moved-pack', icon_url: 'https://old.example.com/resources/default/icon.png' } })
        const build = await db.build.create({ data: { modpack_id: modpack.id, version: '1.0', minecraft: '1.20.1' } })
        const fallback = String.raw`onerror="this.onerror = null; this.src = 'http://[^']+/resources/default/icon.png'"`

        // Modpack page: its header icon and its icon in the modpack rail
        const page = await (await as()).get(`/modpack/view/${modpack.id}`).expect(200)
        expect(page.text).toMatch(new RegExp(`src="https://old.example.com/resources/default/icon.png" alt="" ${fallback}`))
        expect(page.text.match(new RegExp(fallback, 'g'))?.length ?? 0).toBeGreaterThanOrEqual(2)
        expect((await (await as()).get('/modpack/list').expect(200)).text).toMatch(new RegExp(`<img :src="row.icon_url" alt="" ${fallback}`))
        expect((await (await as()).get(`/modpack/build/${build.id}`).expect(200)).text).toMatch(new RegExp(fallback))
    })

    it('shows the create form', async () => {
        await (await as()).get('/modpack/create').expect(200)
    })

    it('rejects a duplicate slug or name', async () => {
        const slug = await (await as()).post('/modpack/create', { name: 'TestModpack2', slug: 'testmodpack' })
        expect(redirectPath(slug)).toBe('/modpack/create')
        expect(flashedErrors(slug)).toHaveProperty('slug')
        const name = await (await as()).post('/modpack/create', { name: 'TestModpack', slug: 'testmodpack2' })
        expect(redirectPath(name)).toBe('/modpack/create')
        expect(flashedErrors(name)).toHaveProperty('name')
    })

    it('creates a modpack', async () => {
        expect(redirectPath(await (await as()).post('/modpack/create', { name: 'TestModpack2', slug: 'testmodpack2' }))).toBe('/modpack/view/2')
    })

    it('shows the delete page and redirects for an unknown modpack', async () => {
        await (await as()).get('/modpack/delete/1').expect(200)
        expect(redirectPath(await (await as()).get('/modpack/delete/100000'))).toBe('/modpack/list')
        expect(redirectPath(await (await as()).post('/modpack/delete/100000'))).toBe('/modpack/list')
    })

    it('deletes a modpack', async () => {
        const response = await (await as()).post('/modpack/delete/1')
        expect(redirectPath(response)).toBe('/modpack/list')
        expect(flashed(response)).toHaveProperty('success')
    })

    it('shows a build', async () => {
        await (await as()).get('/modpack/build/1').expect(200)
    })

    it('clears recommended and latest when the last build is deleted', async () => {
        await db.modpack.update({ where: { id: 1 }, data: { recommended: '1.0.0', latest: '1.0.0' } })
        const response = await (await as()).post('/modpack/build/1/delete')
        expect(redirectPath(response)).toBe('/modpack/view/1')
        const modpack = await db.modpack.findUniqueOrThrow({ where: { id: 1 } })
        expect(modpack.recommended).toBeNull()
        expect(modpack.latest).toBeNull()
        expect(await db.build.count({ where: { modpack_id: 1 } })).toBe(0)
    })

    it('shows the edit form', async () => {
        await (await as()).get('/modpack/edit/1').expect(200)
    })

    it('saves an unchanged modpack', async () => {
        const response = await (await as()).post('/modpack/edit/1', { name: 'TestModpack', slug: 'testmodpack', hidden: false, private: false })
        expect(redirectPath(response)).toBe('/modpack/edit/1')
    })

    it('edits a modpack', async () => {
        const response = await (await as()).post('/modpack/edit/1', { name: 'TestTest', slug: 'test-test', hidden: true, private: true })
        expect(redirectPath(response)).toBe('/modpack/edit/1')
        const modpack = await db.modpack.findUniqueOrThrow({ where: { id: 1 } })
        expect(modpack).toMatchObject({ name: 'TestTest', slug: 'test-test', hidden: true, private: true })
    })

    it('gives clients access', async () => {
        const client = await db.client.findFirstOrThrow()
        const response = await (await as()).post('/modpack/edit/1', { name: 'TestModpack', slug: 'testmodpack', clients: [client.id] })
        expect(redirectPath(response)).toBe('/modpack/edit/1')
        expect((await clientsForModpack(1)).map((c) => c.id)).toEqual([client.id])
    })

    it('removes client access', async () => {
        const client = await db.client.findFirstOrThrow()
        await db.clientModpack.create({ data: { client_id: client.id, modpack_id: 1 } })
        const response = await (await as()).post('/modpack/edit/1', { name: 'TestModpack', slug: 'testmodpack' })
        expect(redirectPath(response)).toBe('/modpack/edit/1')
        expect(await clientsForModpack(1)).toHaveLength(0)
    })

    it.each([
        ['version', { build_id: 9999, version: 1, modversion_id: 1 }],
        ['delete', { build_id: 9999, modversion_id: 1 }],
        ['add', { build: 9999, 'mod-name': 'testmod', 'mod-version': '1.0' }],
        ['add', { build: 1, 'mod-name': 'nonexistent', 'mod-version': '1.0' }],
        ['recommended', { modpack: 9999, recommended: '1.0.0' }],
        ['latest', { modpack: 9999, latest: '1.0.0' }],
        ['published', { build: 9999, published: true }],
        ['private', { build: 9999, private: true }],
    ])('returns 404 from modify/%s for something that does not exist', async (action, data) => {
        await (await as(true)).post(`/modpack/modify/${action}`, data).expect(404)
    })

    it('changes several mod versions at once', async () => {
        const newVersion = await db.modversion.create({ data: { mod_id: 1, version: '2.0', md5: 'abc123' } })
        const response = await (await as(true)).post('/modpack/modify/batch-version', {
            build_id: 1,
            changes: [{ old_modversion_id: 1, new_modversion_id: newVersion.id }],
        })
        expect(response.status).toBe(200)
        expect(response.body).toEqual({ status: 'success', updated: 1 })
        expect(await db.buildModversion.count({ where: { build_id: 1, modversion_id: newVersion.id } })).toBe(1)
        expect(await db.buildModversion.count({ where: { build_id: 1, modversion_id: 1 } })).toBe(0)
    })

    it('accepts an empty batch of changes', async () => {
        const response = await (await as(true)).post('/modpack/modify/batch-version', { build_id: 1, changes: [] })
        expect(response.body).toEqual({ status: 'success', updated: 0 })
    })

    it('refuses to add a second version of a mod already in the build', async () => {
        await db.modversion.create({ data: { mod_id: 1, version: '2.0', md5: 'abc123' } })
        const response = await (await as(true)).post('/modpack/modify/add', { build: 1, 'mod-name': 'testmod', 'mod-version': '2.0' })
        expect(response.body).toEqual({ status: 'failed', reason: 'This mod already exists in the build' })
    })
})
