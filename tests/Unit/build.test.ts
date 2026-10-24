import { config } from '../../src/config.js'
import { db } from '../../src/database/prisma.js'
import { modversionIdsForBuild } from '../../src/models/relations.js'
import { actingAs, admin, client, flashed, flashedErrors, makeUser, redirectPath, useSolder } from '../support/helpers.js'

describe('Builds', () => {
    useSolder()
    const as = async () => actingAs(await admin())
    const api = (path: string) => client().get(`/api/${path}`).set('Accept', 'application/json')

    it('shows a build and the add form', async () => {
        await (await as()).get('/modpack/build/1').expect(200)
        await (await as()).get('/modpack/add-build/1').expect(200)
    })

    it('adds a build', async () => {
        const response = await (await as()).post('/modpack/add-build/1', {
            version: '1.1.0',
            minecraft: '1.7.10',
            'java-version': '1.7',
            'java-runtime': 'java-runtime-delta',
            memory: '1536',
            'memory-enabled': 1,
        })
        expect(redirectPath(response)).toBe('/modpack/build/2')
        const build = await db.build.findUniqueOrThrow({ where: { id: 2 } })
        expect(build).toMatchObject({ version: '1.1.0', minecraft: '1.7.10', min_memory: 1536, min_java: '1.7' })
        await db.build.update({ where: { id: 2 }, data: { is_published: true } })
        const json = await api('modpack/testmodpack/1.1.0').expect(200)
        expect(json.body).toMatchObject({ java: '1.7', java_runtime: 'java-runtime-delta' })
    })

    it('needs a version', async () => {
        const response = await (await as()).post('/modpack/add-build/1', {
            version: '',
            minecraft: '1.7.10',
            'java-version': '1.7',
            'java-runtime': 'java-runtime-gamma',
            memory: '1536',
            'memory-enabled': 1,
        })
        expect(redirectPath(response)).toBe('/modpack/add-build/1')
        expect(flashedErrors(response)).toHaveProperty('version')
        expect((flashed(response)._old_input as Record<string, unknown>)['java-runtime']).toBe('java-runtime-gamma')
    })

    it('needs a Minecraft version', async () => {
        const response = await (await as()).post('/modpack/add-build/1', { version: '1.1.0', minecraft: '', 'java-version': '1.7', memory: '1536', 'memory-enabled': 1 })
        expect(redirectPath(response)).toBe('/modpack/add-build/1')
        expect(flashedErrors(response)).toHaveProperty('minecraft')
    })

    it('adds a build without a Java version', async () => {
        const response = await (await as()).post('/modpack/add-build/1', {
            version: '1.1.0',
            minecraft: '1.7.10',
            'java-version': '',
            'java-runtime': 'jre-legacy',
            memory: '1536',
            'memory-enabled': 1,
        })
        expect(redirectPath(response)).toBe('/modpack/build/2')
        const build = await db.build.findUniqueOrThrow({ where: { id: 2 } })
        expect(build).toMatchObject({ version: '1.1.0', minecraft: '1.7.10', min_memory: 1536, min_java: null })
        await db.build.update({ where: { id: 2 }, data: { is_published: true } })
        expect((await api('modpack/testmodpack/1.1.0').expect(200)).body.java_runtime).toBe('jre-legacy')
    })

    it('adds a build without a memory requirement', async () => {
        const response = await (await as()).post('/modpack/add-build/1', { version: '1.1.0', minecraft: '1.7.10', 'java-version': '1.7', memory: 0, 'memory-enabled': 0 })
        expect(redirectPath(response)).toBe('/modpack/build/2')
        expect(await db.build.findUniqueOrThrow({ where: { id: 2 } })).toMatchObject({ version: '1.1.0', minecraft: '1.7.10', min_memory: 0, min_java: '1.7' })
    })

    it('shows the edit form', async () => {
        await (await as()).get('/modpack/build/1/edit').expect(200)
    })

    it('edits a build', async () => {
        await db.build.update({ where: { id: 1 }, data: { java_runtime: 'java-runtime-gamma' } })
        expect((await api('modpack/testmodpack/1.0.0').expect(200)).body.java_runtime).toBe('java-runtime-gamma')
        const response = await (await as()).post('/modpack/build/1/edit', {
            version: '1.0.0',
            minecraft: '1.7.10',
            'java-version': '1.8',
            'java-runtime': '',
            memory: '1024',
            'memory-enabled': '1',
        })
        expect(redirectPath(response)).toBe('/modpack/build/1')
        expect(await db.build.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({ min_memory: 1024, min_java: '1.8' })
        const json = await api('modpack/testmodpack/1.0.0').expect(200)
        expect(json.body).toMatchObject({ java: '1.8', java_runtime: null })
    })

    it('keeps the runtime override when the advanced controls are hidden', async () => {
        config.solder.advanced_mode = false
        await db.build.update({ where: { id: 1 }, data: { java_runtime: 'java-runtime-delta' } })
        expect((await api('modpack/testmodpack/1.0.0').expect(200)).body.java_runtime).toBe('java-runtime-delta')
        const response = await (await as()).post('/modpack/build/1/edit', { version: '1.0.0', minecraft: '1.7.10', 'java-version': '1.8' })
        expect(redirectPath(response)).toBe('/modpack/build/1')
        expect((await api('modpack/testmodpack/1.0.0').expect(200)).body).toMatchObject({ java: '1.8', java_runtime: 'java-runtime-delta' })
    })

    it('rejects an invalid Java runtime', async () => {
        await db.build.update({ where: { id: 1 }, data: { java_runtime: 'java-runtime-gamma' } })
        const data: Record<string, unknown> = { version: 'invalid-runtime', minecraft: '1.20.1', 'java-runtime': ['java-runtime-delta'] }
        const create = await (await as()).post('/modpack/add-build/1', data)
        expect(redirectPath(create)).toBe('/modpack/add-build/1')
        expect(flashedErrors(create)).toHaveProperty('java-runtime')
        expect(await db.build.count({ where: { modpack_id: 1, version: 'invalid-runtime' } })).toBe(0)

        data['java-runtime'] = '../../bin/java'
        const edit = await (await as()).post('/modpack/build/1/edit', data)
        expect(redirectPath(edit)).toBe('/modpack/build/1/edit')
        expect(flashedErrors(edit)).toHaveProperty('java-runtime')
        expect((await api('modpack/testmodpack/1.0.0').expect(200)).body).toMatchObject({ minecraft: '1.7.10', java: '1.7', java_runtime: 'java-runtime-gamma' })
    })

    it('deletes a build', async () => {
        await (await as()).get('/modpack/build/1/delete').expect(200)
        expect(redirectPath(await (await as()).post('/modpack/build/1/delete'))).toBe('/modpack/view/1')
    })

    it('exports a build as CSV', async () => {
        const response = await (await as()).get('/modpack/build/1/export').expect(200)
        expect(response.headers['content-type']).toBe('text/csv; charset=UTF-8')
        expect(response.headers['content-disposition']).toBe('attachment; filename=testmodpack_1.0.0.csv')
        expect(response.text).toContain('mod_name,mod_slug,version,md5,filesize')
        expect(response.text).toContain('TestMod,testmod,1.0,bdbc6c6cc48c7b037e4aef64b58258a3,295')
        expect(redirectPath(await (await as()).get('/modpack/build/999/export'))).toBe('/modpack/list')
    })

    it.each(['recommended', 'latest'] as const)('renames the %s build of the modpack along with the build', async (field) => {
        await db.modpack.update({ where: { id: 1 }, data: { [field]: '1.0.0' } })
        const response = await (await as()).post('/modpack/build/1/edit', { version: '2.0.0', minecraft: '1.7.10', 'java-version': '1.8', memory: '1024', 'memory-enabled': '1' })
        expect(redirectPath(response)).toBe('/modpack/build/1')
        expect((await db.build.findUniqueOrThrow({ where: { id: 1 } })).version).toBe('2.0.0')
        expect((await db.modpack.findUniqueOrThrow({ where: { id: 1 } }))[field]).toBe('2.0.0')
    })

    it('clones a build of the same modpack', async () => {
        await db.build.update({ where: { id: 1 }, data: { java_runtime: 'java-runtime-delta' } })
        const response = await (await as()).post('/modpack/add-build/1', { version: '1.1.0', minecraft: '1.7.10', clone: 1 })
        const newBuild = await db.build.findFirstOrThrow({ where: { version: '1.1.0', modpack_id: 1 } })
        expect(redirectPath(response)).toBe(`/modpack/build/${newBuild.id}`)
        expect(await modversionIdsForBuild(newBuild.id)).toHaveLength((await modversionIdsForBuild(1)).length)
        await db.build.update({ where: { id: newBuild.id }, data: { is_published: true } })
        expect((await api('modpack/testmodpack/1.1.0').expect(200)).body.java_runtime).toBeNull()
    })

    it('clones a build of another modpack', async () => {
        const target = await db.modpack.create({ data: { name: 'TargetPack', slug: 'targetpack' } })
        const response = await (await as()).post(`/modpack/add-build/${target.id}`, { version: '1.0.0', minecraft: '1.7.10', clone: 1 })
        const newBuild = await db.build.findFirstOrThrow({ where: { version: '1.0.0', modpack_id: target.id } })
        expect(redirectPath(response)).toBe(`/modpack/build/${newBuild.id}`)
        expect(await modversionIdsForBuild(newBuild.id)).toHaveLength((await modversionIdsForBuild(1)).length)
    })

    it('reports a clone source that does not exist', async () => {
        const response = await (await as()).post('/modpack/add-build/1', { version: '1.1.0', minecraft: '1.7.10', clone: 99999 })
        const newBuild = await db.build.findFirstOrThrow({ where: { version: '1.1.0', modpack_id: 1 } })
        expect(redirectPath(response)).toBe(`/modpack/build/${newBuild.id}`)
        expect(Object.keys(flashedErrors(response)).length).toBeGreaterThan(0)
    })

    it('refuses to clone from a modpack the user cannot access', async () => {
        const target = await db.modpack.create({ data: { name: 'RestrictedPack', slug: 'restrictedpack' } })
        const restricted = await makeUser({ modpacks_create: true, modpacks_manage: true, modpacks: [target.id] })
        const response = await actingAs(restricted).post(`/modpack/add-build/${target.id}`, { version: '1.0.0', minecraft: '1.7.10', clone: 1 })
        const newBuild = await db.build.findFirstOrThrow({ where: { version: '1.0.0', modpack_id: target.id } })
        expect(redirectPath(response)).toBe(`/modpack/build/${newBuild.id}`)
        expect(Object.keys(flashedErrors(response)).length).toBeGreaterThan(0)
    })
})
