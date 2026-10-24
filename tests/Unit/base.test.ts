import { actingAs, admin, client, flashedErrors, redirectPath, useSolder } from '../support/helpers.js'

describe('Base', () => {
    useSolder()

    it('shows the login page', async () => {
        await client().get('/login').expect(200)
    })

    it('rejects bad credentials', async () => {
        const response = await client().post('/login', { email: 'test@example.com', password: 'ifail', remember: false })
        expect(response.status).toBe(302)
        expect(flashedErrors(response)).toHaveProperty('email')
    })

    it('logs in with good credentials', async () => {
        const response = await client().post('/login', { email: 'admin@example.com', password: 'admin', remember: false })
        expect(response.status).toBe(302)
        expect(redirectPath(response)).toBe('/dashboard')
    })

    it('redirects the index to the dashboard', async () => {
        const response = await actingAs(await admin()).get('/')
        expect(redirectPath(response)).toBe('/dashboard')
    })

    it('sends guests to the login page', async () => {
        const response = await client().get('/dashboard')
        expect(redirectPath(response)).toBe('/login')
    })

    it('shows the dashboard', async () => {
        await actingAs(await admin()).get('/dashboard').expect(200)
    })
})
