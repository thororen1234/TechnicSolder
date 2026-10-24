import { db } from '../../src/database/prisma.js'
import { actingAs, admin, flashed, flashedErrors, redirectPath, useSolder } from '../support/helpers.js'

describe('Clients', () => {
    useSolder()
    const as = async () => actingAs(await admin())

    it('redirects the index to the list', async () => {
        expect(redirectPath(await (await as()).get('/client'))).toBe('/client/list')
    })

    it('shows the create form', async () => {
        await (await as()).get('/client/create').expect(200)
    })

    it('rejects a duplicate UUID', async () => {
        const response = await (await as()).post('/client/create', { name: 'TestClient2', uuid: '2ezf6f26-eb15-4ccb-9f0b-8z5ed2c72946' })
        expect(redirectPath(response)).toBe('/client/create')
        expect(flashedErrors(response)).toHaveProperty('uuid')
    })

    it('rejects a duplicate name', async () => {
        const response = await (await as()).post('/client/create', { name: 'TestClient', uuid: '3abf6f26-eb15-4ccb-9f0b-8z5ed3c72946' })
        expect(redirectPath(response)).toBe('/client/create')
        expect(flashedErrors(response)).toHaveProperty('name')
    })

    it('creates a client', async () => {
        const response = await (await as()).post('/client/create', { name: 'TestClient2', uuid: '3abf6f26-eb15-4ccb-9f0b-8z5ed3c72946' })
        expect(redirectPath(response)).toBe('/client/list')
        expect(flashed(response)).toHaveProperty('success')
    })

    it('shows the delete page', async () => {
        await (await as()).get('/client/delete/1').expect(200)
    })

    it('redirects for an unknown client', async () => {
        expect(redirectPath(await (await as()).get('/client/delete/100000'))).toBe('/client/list')
        expect(redirectPath(await (await as()).post('/client/delete/100000'))).toBe('/client/list')
    })

    it('deletes a client', async () => {
        const client = await db.client.findFirstOrThrow({ where: { name: 'TestClient' } })
        const response = await (await as()).post(`/client/delete/${client.id}`)
        expect(redirectPath(response)).toBe('/client/list')
        expect(flashed(response)).toHaveProperty('success')
    })

    it('lists clients', async () => {
        await (await as()).get('/client/list').expect(200)
    })
})
