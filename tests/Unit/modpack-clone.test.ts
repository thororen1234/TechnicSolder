import { db } from '../../src/database/prisma.js'
import { buildsForModpack, modversionIdsForBuild } from '../../src/models/relations.js'
import { actingAs, admin, bearerToken, client, flashedErrors, redirectPath, useSolder } from '../support/helpers.js'

describe('Cloning modpacks', () => {
    useSolder()
    const as = async () => actingAs(await admin())
    const api = (path: string) => client().get(`/api/${path}`)

    it('shows the clone form', async () => {
        await (await as()).get('/modpack/clone/1').expect(200)
    })

    it('clones a modpack', async () => {
        const response = await (await as()).post('/modpack/clone/1', { name: 'Cloned Modpack', slug: 'cloned-modpack' })
        const clone = await db.modpack.findFirstOrThrow({ where: { slug: 'cloned-modpack' } })
        expect(redirectPath(response)).toBe(`/modpack/view/${clone.id}`)
    })

    it('copies the builds and their mods', async () => {
        await db.build.update({ where: { id: 1 }, data: { min_java: '1.8', java_runtime: 'java-runtime-delta', is_published: true } })
        const originals = await buildsForModpack(1)
        await (await as()).post('/modpack/clone/1', { name: 'Cloned With Builds', slug: 'cloned-with-builds' })
        const clone = await db.modpack.findFirstOrThrow({ where: { slug: 'cloned-with-builds' } })
        expect(await db.build.count({ where: { modpack_id: clone.id } })).toBe(originals.length)
        for (const original of originals) {
            const copy = await db.build.findFirstOrThrow({ where: { modpack_id: clone.id, version: original.version } })
            expect(await modversionIdsForBuild(copy.id)).toHaveLength((await modversionIdsForBuild(original.id)).length)
            const json = await api(`modpack/${clone.slug}/${copy.version}`).expect(200)
            expect(json.body).toMatchObject({ java: original.min_java, java_runtime: original.java_runtime })
        }
    })

    it('keeps the runtime and mods when cloning through the API', async () => {
        await db.build.update({ where: { id: 1 }, data: { min_java: '1.8', java_runtime: 'java-runtime-delta' } })
        const source = await api('modpack/testmodpack/1.0.0').expect(200)
        const token = await bearerToken(await admin())
        await client({ token }).postJson('/api/modpack/testmodpack/clone', { name: 'API Cloned Pack', slug: 'api-cloned-pack' }).expect(201)
        const json = await api('modpack/api-cloned-pack/1.0.0').expect(200)
        expect(json.body).toMatchObject({ java: '1.8', java_runtime: 'java-runtime-delta', mods: source.body.mods })
    })

    it('rejects a slug that is taken', async () => {
        const response = await (await as()).post('/modpack/clone/1', { name: 'Another Modpack', slug: 'testmodpack' })
        expect(redirectPath(response)).toBe('/modpack/clone/1')
        expect(flashedErrors(response)).toHaveProperty('slug')
    })
})
