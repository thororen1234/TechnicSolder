import { config } from '../../src/config.js'
import { db } from '../../src/database/prisma.js'
import { Http } from '../../src/support/http.js'
import { actingAs, admin, expectSee, fakeFabricMeta, flashed, flashedErrors, redirectPath, useModRepository, useSolder } from '../support/helpers.js'

describe('Mods', () => {
    useSolder()
    const as = async (ajax = false) => actingAs(await admin(), { ajax })

    it('redirects the index to the list', async () => {
        expect(redirectPath(await (await as()).get('/mod'))).toBe('/mod/list')
    })

    it('lists mods and shows the create form', async () => {
        await (await as()).get('/mod/list').expect(200)
        await (await as()).get('/mod/create').expect(200)
    })

    it('rejects a duplicate slug', async () => {
        const response = await (await as()).post('/mod/create', { pretty_name: 'TestMod', name: 'testmod' })
        expect(redirectPath(response)).toBe('/mod/create')
        expect(flashedErrors(response)).toHaveProperty('name')
    })

    it('rejects an invalid website', async () => {
        const response = await (await as()).post('/mod/create', { pretty_name: 'TestMod', name: 'testmod2', link: 'solder/io' })
        expect(redirectPath(response)).toBe('/mod/create')
        expect(flashedErrors(response)).toHaveProperty('link')
    })

    it('creates a mod', async () => {
        const response = await (await as()).post('/mod/create', {
            pretty_name: 'Random mod name',
            name: 'random-mod-name',
            link: 'http://technicpack.net',
            notes: 'Test note',
        })
        expect(redirectPath(response)).toBe('/mod/view/3')
        expect(await db.mod.findFirst({ where: { name: 'random-mod-name', notes: 'Test note' } })).not.toBeNull()
    })

    describe('adding versions', () => {
        it('only answers AJAX requests', async () => {
            await (await as()).post('/mod/add-version/', { 'add-version': 'v1.5.2.v01', 'add-md5': '9ece64de3e11a0f15f55ef34f2194760', 'mod-id': '2' }).expect(404)
        })

        it('needs a version and a mod', async () => {
            const noVersion = await (await as(true)).post('/mod/add-version/', { md5: '9ece64de3e11a0f15f55ef34f2194760', 'mod-id': '2' }).expect(200)
            expect(noVersion.body).toEqual({ status: 'error', reason: 'Missing Post Data' })
            const noMod = await (await as(true)).post('/mod/add-version/', { 'add-version': 'v1.5.2.v01', 'add-md5': '9ece64de3e11a0f15f55ef34f2194760' })
            expect(noMod.body).toEqual({ status: 'error', reason: 'Missing Post Data' })
        })

        it('rejects an unknown mod', async () => {
            const response = await (await as(true)).post('/mod/add-version/', { 'add-version': 'v1.5.2.v01', 'add-md5': '9ece64de3e11a0f15f55ef34f2194760', 'mod-id': '1000000' })
            expect(response.body).toEqual({ status: 'error', reason: 'Could not pull mod from database' })
        })

        it('uses a given MD5 without reading the file', async () => {
            const response = await (await as(true)).post('/mod/add-version/', { 'add-version': '1.7.10-4.0.0', 'add-md5': '0925fb5cca71b6e8dd81fac9b257c6d4', 'mod-id': '2' })
            expect(response.body).toMatchObject({ status: 'success', version: '1.7.10-4.0.0', md5: '0925fb5cca71b6e8dd81fac9b257c6d4' })
            expect(response.body).toHaveProperty('version_id')
            expect(response.body).toHaveProperty('filesize')
        })

        it('hashes the file when no MD5 is given', async () => {
            const response = await (await as(true)).post('/mod/add-version/', { 'add-version': '1.7.10-4.0.0', 'add-md5': '', 'mod-id': '2' })
            expect(response.body).toMatchObject({ status: 'success', version: '1.7.10-4.0.0', md5: '0925fb5cca71b6e8dd81fac9b257c6d4', filesize: '8.89 KiB' })
        })

        it('rejects an invalid MD5', async () => {
            const response = await (await as(true)).post('/mod/add-version/', { 'add-version': '1.7.10-4.0.0', 'add-md5': 'not-a-valid-md5', 'mod-id': '2' })
            expect(response.body).toEqual({ status: 'error', reason: 'Invalid MD5 hash format' })
        })

        it('accepts a given MD5 for a file that is missing', async () => {
            const response = await (await as(true)).post('/mod/add-version/', { 'add-version': '99.99.99', 'add-md5': 'aabbccdd00112233aabbccdd00112233', 'mod-id': '2' })
            expect(response.body).toMatchObject({ status: 'success', version: '99.99.99', md5: 'aabbccdd00112233aabbccdd00112233' })
        })

        it('reports a missing file when hashing', async () => {
            const response = await (await as(true)).post('/mod/add-version/', { 'add-version': 'v1.5.2.1', 'add-md5': '', 'mod-id': '2' }).expect(200)
            expect(response.body).toEqual({
                status: 'error',
                reason: `MD5 hashing failed. ${config.solder.repo_location}mods/backtools/backtools-v1.5.2.1.zip does not exist`,
            })
        })

        it('reports a missing file in a remote repository when hashing', async () => {
            config.solder.repo_location = 'https://mods.example.com/'
            Http.fake({ 'mods.example.com/*': { status: 404 } })
            const response = await (await as(true)).post('/mod/add-version/', { 'add-version': 'v1.5.2.1', 'add-md5': '', 'mod-id': '2' }).expect(200)
            expect(response.body).toEqual({ status: 'error', reason: 'MD5 hashing failed. Expected status code 200, got 404' })
        })
    })

    describe('rehashing', () => {
        it('only answers AJAX requests', async () => {
            await (await as()).post('/mod/rehash/', { 'version-id': '2', md5: '9ece64de3e11a0f15f55ef34f2194760' }).expect(404)
        })

        it('needs a known version', async () => {
            expect((await (await as(true)).post('/mod/rehash/', { 'version-id': '', md5: '9ece64de3e11a0f15f55ef34f2194760' })).body).toEqual({
                status: 'error',
                reason: 'Missing Post Data',
            })
            expect((await (await as(true)).post('/mod/rehash/', { 'version-id': '10000000', md5: '9ece64de3e11a0f15f55ef34f2194760' })).body).toEqual({
                status: 'error',
                reason: 'Could not pull mod version from database',
            })
        })

        it('stores a given MD5', async () => {
            const response = await (await as(true)).post('/mod/rehash/', { 'version-id': '1', md5: 'bdbc6c6cc48c7b037e4aef64b58258a3' })
            expect(response.body).toMatchObject({ status: 'success', version_id: 1, md5: 'bdbc6c6cc48c7b037e4aef64b58258a3' })
        })

        it('rejects an invalid MD5', async () => {
            expect((await (await as(true)).post('/mod/rehash/', { 'version-id': '1', md5: 'not-a-valid-md5' })).body).toEqual({
                status: 'error',
                reason: 'Invalid MD5 hash format',
            })
        })

        it('hashes the file when no MD5 is given', async () => {
            const response = await (await as(true)).post('/mod/rehash/', { 'version-id': '1', md5: '' })
            expect(response.body).toMatchObject({ status: 'success', version_id: 1, md5: 'bdbc6c6cc48c7b037e4aef64b58258a3', filesize: '295 bytes' })
        })
    })

    describe('deleting versions', () => {
        it('only answers AJAX requests with an ID', async () => {
            await (await as()).post('/mod/delete-version/1').expect(404)
            await (await as(true)).post('/mod/delete-version/').expect(404)
        })

        it('rejects an unknown version', async () => {
            expect((await (await as(true)).post('/mod/delete-version/10000000')).body).toEqual({ status: 'error', reason: 'Could not pull mod version from database' })
        })

        it('refuses to delete a version in use', async () => {
            expect((await (await as(true)).post('/mod/delete-version/1')).body).toEqual({
                status: 'error',
                reason: 'This version is in use by 1 build(s) and cannot be deleted.',
            })
        })

        it('deletes a version', async () => {
            await db.buildModversion.deleteMany({ where: { modversion_id: 1 } })
            expect((await (await as(true)).post('/mod/delete-version/1')).body).toEqual({ status: 'success', version_id: 1, version: '1.0' })
        })
    })

    describe('deleting mods', () => {
        it('shows the delete page', async () => {
            await (await as()).get('/mod/delete/1').expect(200)
        })

        it('redirects for an unknown mod', async () => {
            expect(redirectPath(await (await as()).get('/mod/delete/100000'))).toBe('/mod/list')
            expect(redirectPath(await (await as()).post('/mod/delete/100000'))).toBe('/mod/list')
        })

        it('deletes a mod', async () => {
            const mod = await db.mod.findFirstOrThrow({ where: { name: 'backtools' } })
            const response = await (await as()).post(`/mod/delete/${mod.id}`)
            expect(redirectPath(response)).toBe('/mod/list')
            expect(flashed(response)).toHaveProperty('success')
        })
    })

    it('lists the versions of a mod', async () => {
        const response = await (await as(true)).get('/mod/versions/testmod').expect(200)
        expect(response.body).toEqual({
            id: 1,
            name: 'testmod',
            pretty_name: 'TestMod',
            author: 'Technic',
            description: 'This is a test mod for Solder',
            link: 'http://solder.io',
            versions: ['1.0'],
        })
        expect((await (await as(true)).get('/mod/versions/invalid')).body).toEqual({ status: 'error', reason: 'Unknown mod' })
    })

    describe('importing', () => {
        useModRepository()

        function fakeProviders(): void {
            fakeFabricMeta()
            Http.fake({ 'api.modrinth.com/v2/search*': { body: { hits: [], total_hits: 0 } } })
        }

        it('shows the default search', async () => {
            fakeProviders()
            await (await as()).get('/mod/import').expect(200)
        })

        it('shows a provider search', async () => {
            fakeProviders()
            expectSee(await (await as()).get('/mod/import/fabric').expect(200), 'Fabric Loader 1.18.2')
        })

        it('falls back to an initial when a mod has no icon', async () => {
            Http.fake({
                'api.modrinth.com/v2/search*': {
                    body: {
                        total_hits: 2,
                        hits: [
                            { project_id: 'a1', slug: 'sodium', title: 'Sodium', icon_url: 'https://cdn.modrinth.com/sodium.png' },
                            { project_id: 'b2', slug: 'iris', title: 'iris shaders', icon_url: null },
                        ],
                    },
                },
            })
            const response = await (await as()).get('/mod/import/modrinth/shaders').expect(200)
            expect(response.text).toContain('src="https://cdn.modrinth.com/sodium.png"')
            expect(response.text).toContain('aria-hidden="true">I</span>')
            expect(response.text).toContain('onerror="this.hidden = true; this.previousElementSibling.hidden = false"')
        })

        it('shows the details of a mod', async () => {
            fakeProviders()
            expectSee(await (await as()).get('/mod/import/details/fabric/1.18.2').expect(200), 'Fabric Loader 1.18.2')
        })

        it('rejects an unknown provider', async () => {
            fakeProviders()
            const response = await (await as()).get('/mod/import/details/nope/1.18.2')
            expect(redirectPath(response)).toBe('/mod/import')
            expect(flashedErrors(response)).toHaveProperty('invalid_provider')
        })

        it('rejects versions the mod does not have', async () => {
            fakeProviders()
            const response = await (await as()).post('/mod/import/details/fabric/1.18.2', { versions: [Buffer.from('9.9.9-9.9.9').toString('base64')] })
            expect(flashedErrors(response)).toHaveProperty('invalid_versions')
        })

        it('needs at least one version', async () => {
            fakeProviders()
            expect(flashedErrors(await (await as()).post('/mod/import/details/fabric/1.18.2', {}))).toHaveProperty('no_versions')
        })

        const importLoader = async () =>
            (await as()).post('/mod/import/details/fabric/1.18.2', { versions: [Buffer.from('1.18.2-0.14.9').toString('base64')] })

        it('imports a version', async () => {
            fakeProviders()
            const response = await importLoader()
            expect(redirectPath(response)).toBe('/mod/view/3')
            expect(flashedErrors(response)).toEqual({})
            expect(flashed(response).success).toBe('Imported 1 version.')
        })

        it('reports a version that already exists', async () => {
            fakeProviders()
            await importLoader()
            const response = await importLoader()
            expect(redirectPath(response)).toBe('/mod/view/3')
            expect(flashedErrors(response)).toEqual({})
            expect(flashed(response).success).toBe('1 version already existed.')
            expect(await db.modversion.count({ where: { mod_id: 3 } })).toBe(1)
        })
    })
})
