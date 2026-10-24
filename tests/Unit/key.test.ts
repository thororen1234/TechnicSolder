import { db } from '../../src/database/prisma.js'
import { actingAs, admin, flashed, flashedErrors, redirectPath, useSolder } from '../support/helpers.js'

describe('Platform keys', () => {
    useSolder()
    const as = async () => actingAs(await admin())

    it('redirects the index to the list', async () => {
        expect(redirectPath(await (await as()).get('/key'))).toBe('/key/list')
    })

    it('shows the create form', async () => {
        await (await as()).get('/key/create').expect(200)
    })

    it('rejects a duplicate key', async () => {
        const response = await (await as()).post('/key/create', { name: 'TestKey2', api_key: 'sfIvEcNueZtwKsTAIYOIYng1iuPAgavJsfIvEcNueZtwKsTAIYOIYng1iuPAgavJ' })
        expect(redirectPath(response)).toBe('/key/create')
        expect(flashedErrors(response)).toHaveProperty('api_key')
    })

    it('rejects a duplicate name', async () => {
        const response = await (await as()).post('/key/create', { name: 'TestKey', api_key: 'abIvEcNueZtwKsTAIYOIYng1iuPAgavJsfIvEcNueZtwKsTAIYOIYng1iuPAgavJ' })
        expect(redirectPath(response)).toBe('/key/create')
        expect(flashedErrors(response)).toHaveProperty('name')
    })

    it('creates a key', async () => {
        const response = await (await as()).post('/key/create', { name: 'TestKey2', api_key: 'abCvEcNueZtwKsTAIYOIYng1iuPAgavJsfIvEcNueZtwKsTAIYOIYng1iuPAgavJ' })
        expect(redirectPath(response)).toBe('/key/list')
        expect(flashed(response)).toHaveProperty('success')
    })

    it('shows the delete page', async () => {
        await (await as()).get('/key/delete/1').expect(200)
    })

    it('redirects for an unknown key', async () => {
        expect(redirectPath(await (await as()).get('/key/delete/100000'))).toBe('/key/list')
        expect(redirectPath(await (await as()).post('/key/delete/100000'))).toBe('/key/list')
    })

    it('deletes a key', async () => {
        const key = await db.key.findFirstOrThrow()
        const response = await (await as()).post(`/key/delete/${key.id}`)
        expect(redirectPath(response)).toBe('/key/list')
        expect(flashed(response)).toHaveProperty('success')
    })

    it('lists keys', async () => {
        await (await as()).get('/key/list').expect(200)
    })
})
