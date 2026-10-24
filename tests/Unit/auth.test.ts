import bcrypt from 'bcryptjs'
import { verifyPassword } from '../../src/auth/passwords.js'
import { codeAt, decryptSecret } from '../../src/auth/two-factor.js'
import { db } from '../../src/database/prisma.js'
import { Cache } from '../../src/support/cache.js'
import { actingAs, admin, agent, flashed, flashedErrors, redirectPath, useSolder } from '../support/helpers.js'

const currentCode = (secret: string) => codeAt(secret, Math.floor(Date.now() / 30_000))

/** Turn on two-factor authentication for the admin, as they would from their profile */
async function enableAndConfirmTwoFactor(): Promise<void> {
    const browser = agent()
    await browser.post('/login', { email: 'admin@example.com', password: 'admin' })
    await browser.post('/user/two-factor-authentication')
    const secret = decryptSecret(await admin())!
    await browser.post('/user/confirmed-two-factor-authentication', { code: currentCode(secret) })
    expect((await admin()).two_factor_confirmed_at).not.toBeNull()
}

describe('Signing in', () => {
    useSolder()

    it('signs in with valid credentials', async () => {
        const browser = agent()
        expect(redirectPath(await browser.post('/login', { email: 'admin@example.com', password: 'admin' }))).toBe('/dashboard')
        expect(await browser.isAuthenticated()).toBe(true)
    })

    it.each([
        ['a wrong password', 'admin@example.com', 'wrong'],
        ['an unknown email', 'nobody@example.com', 'anything'],
    ])('rejects %s', async (_name, email, password) => {
        const browser = agent()
        const response = await browser.post('/login', { email, password })
        expect(response.status).toBe(302)
        expect(flashedErrors(response)).toHaveProperty('email')
        expect(await browser.isAuthenticated()).toBe(false)
    })

    it('needs an email and password', async () => {
        const errors = flashedErrors(await agent().post('/login', { email: '', password: '' }))
        expect(errors).toHaveProperty('email')
        expect(errors).toHaveProperty('password')
    })

    it('records the IP address', async () => {
        await agent().post('/login', { email: 'admin@example.com', password: 'admin' })
        expect((await admin()).last_ip).not.toBeNull()
    })

    it('does not sign in or record the IP before the two-factor challenge', async () => {
        await enableAndConfirmTwoFactor()
        await db.user.update({ where: { id: 1 }, data: { last_ip: '10.0.0.1' } })
        const browser = agent()
        const response = await browser.post('/login', { email: 'admin@example.com', password: 'admin' })
        expect(redirectPath(response)).toBe('/two-factor-challenge')
        expect(await browser.isAuthenticated()).toBe(false)
        expect((await admin()).last_ip).toBe('10.0.0.1')
    })

    it('records the IP once the two-factor challenge passes', async () => {
        await enableAndConfirmTwoFactor()
        await db.user.update({ where: { id: 1 }, data: { last_ip: '10.0.0.1' } })
        const secret = decryptSecret(await admin())!
        // Confirming above used the current code; forget that so the same code works for the challenge
        await Cache.flush()
        const browser = agent()
        await browser.post('/login', { email: 'admin@example.com', password: 'admin' })
        const response = await browser.post('/two-factor-challenge', { code: currentCode(secret) })
        expect(redirectPath(response)).toBe('/dashboard')
        expect(await browser.isAuthenticated()).toBe(true)
        expect((await admin()).last_ip).toMatch(/127\.0\.0\.1$/)
    })

    it('rehashes a password made with a different work factor', async () => {
        const staleHash = (await bcrypt.hash('admin', 6)).replace(/^\$2[ab]\$/, '$2y$')
        await db.user.update({ where: { id: 1 }, data: { password: staleHash } })
        const browser = agent()
        await browser.post('/login', { email: 'admin@example.com', password: 'admin' })
        expect(await browser.isAuthenticated()).toBe(true)
        const user = await admin()
        expect(user.password).not.toBe(staleHash)
        expect(await verifyPassword('admin', user.password)).toBe(true)
    })

    it('sets a remember token', async () => {
        await agent().post('/login', { email: 'admin@example.com', password: 'admin', remember: true })
        expect((await admin()).remember_token).not.toBe('')
    })

    it('sends signed-in users from the login page to the dashboard', async () => {
        expect(redirectPath(await actingAs(await admin()).get('/login'))).toBe('/dashboard')
    })

    it('signs out', async () => {
        const browser = agent()
        await browser.post('/login', { email: 'admin@example.com', password: 'admin' })
        const response = await browser.post('/logout')
        expect(redirectPath(response)).toBe('/login')
        expect(flashed(response).status).toBe('You have been logged out.')
        expect(await browser.isAuthenticated()).toBe(false)
    })

    describe('rate limiting', () => {
        it('blocks after too many attempts', async () => {
            const browser = agent()
            for (let i = 0; i < 5; i++) {
                await browser.post('/login', { email: 'admin@example.com', password: 'wrong' })
            }
            expect((await browser.post('/login', { email: 'admin@example.com', password: 'wrong' })).status).toBe(429)
        })

        it('is not bypassed by email casing', async () => {
            const browser = agent()
            for (const variant of ['admin@example.com', 'Admin@example.com', 'ADMIN@EXAMPLE.COM', 'AdMiN@ExAmPlE.cOm', 'aDMIN@example.COM']) {
                await browser.post('/login', { email: variant, password: 'wrong' })
            }
            expect((await browser.post('/login', { email: 'admin@example.com', password: 'wrong' })).status).toBe(429)
        })

        it('is not bypassed by homoglyphs', async () => {
            const browser = agent()
            for (let i = 0; i < 3; i++) {
                await browser.post('/login', { email: 'admin@example.com', password: 'wrong' })
            }
            for (const homoglyph of ['ádmin@example.com', 'admın@example.com']) {
                await browser.post('/login', { email: homoglyph, password: 'wrong' })
            }
            expect((await browser.post('/login', { email: 'admin@example.com', password: 'wrong' })).status).toBe(429)
        })

        it('still lets the right password in after a few failures', async () => {
            const browser = agent()
            for (let i = 0; i < 3; i++) {
                await browser.post('/login', { email: 'admin@example.com', password: 'wrong' })
            }
            expect(redirectPath(await browser.post('/login', { email: 'admin@example.com', password: 'admin' }))).toBe('/dashboard')
            expect(await browser.isAuthenticated()).toBe(true)
        })
    })
})
