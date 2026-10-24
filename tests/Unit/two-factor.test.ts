import { codeAt, decryptSecret, recoveryCodes } from '../../src/auth/two-factor.js'
import { db } from '../../src/database/prisma.js'
import type { User } from '../../src/models/types.js'
import { Cache } from '../../src/support/cache.js'
import { actingAs, admin, agent, client, expectSee, flashedErrors, makeUser, redirectPath, useSolder } from '../support/helpers.js'

const currentCode = (secret: string) => codeAt(secret, Math.floor(Date.now() / 30_000))
const fresh = (user: Pick<User, 'id'>) => db.user.findUniqueOrThrow({ where: { id: user.id } })

/** A signed-in session (which counts as a recent password confirmation) */
async function signIn(email = 'admin@example.com', password = 'admin') {
    const browser = agent()
    await browser.post('/login', { email, password })
    return browser
}

/** Enable and confirm two-factor authentication, returning the signed-in session */
async function enableAndConfirm(email = 'admin@example.com', password = 'admin') {
    const browser = await signIn(email, password)
    await browser.post('/user/two-factor-authentication')
    const user = await db.user.findFirstOrThrow({ where: { email } })
    await browser.post('/user/confirmed-two-factor-authentication', { code: currentCode(decryptSecret(user)!) })
    expect((await fresh(user)).two_factor_confirmed_at).not.toBeNull()
    return browser
}

/** A new session that has passed the password step and waits for the second factor */
async function challenged() {
    const browser = agent()
    expect(redirectPath(await browser.post('/login', { email: 'admin@example.com', password: 'admin' }))).toBe('/two-factor-challenge')
    return browser
}

describe('Two-factor authentication', () => {
    useSolder()

    it('can be enabled, showing a QR code', async () => {
        const browser = await signIn()
        await browser.post('/user/two-factor-authentication')
        expect((await admin()).two_factor_secret).not.toBeNull()
        expect((await browser.get('/user/edit/1').expect(200)).text).toContain('<svg')
    })

    it('is confirmed with a valid code, not an invalid one', async () => {
        const browser = await signIn()
        await browser.post('/user/two-factor-authentication')
        const rejected = await browser.post('/user/confirmed-two-factor-authentication', { code: '000000' })
        expect(Object.keys(flashedErrors(rejected)).length).toBeGreaterThan(0)
        expect((await admin()).two_factor_confirmed_at).toBeNull()
        await browser.post('/user/confirmed-two-factor-authentication', { code: currentCode(decryptSecret(await admin())!) })
        expect((await admin()).two_factor_confirmed_at).not.toBeNull()
    })

    it('has eight recovery codes, which can be regenerated', async () => {
        const browser = await enableAndConfirm()
        const codes = recoveryCodes(await admin())
        expect(codes).toHaveLength(8)
        await browser.post('/user/two-factor-recovery-codes')
        expect(recoveryCodes(await admin())).not.toEqual(codes)
    })

    it('can be disabled', async () => {
        const browser = await enableAndConfirm()
        await browser.delete('/user/two-factor-authentication')
        expect(await admin()).toMatchObject({ two_factor_secret: null, two_factor_confirmed_at: null })
    })

    describe('the challenge', () => {
        beforeEach(async () => {
            await enableAndConfirm()
        })

        it('is shown after the password', async () => {
            const browser = await challenged()
            expect(await browser.isAuthenticated()).toBe(false)
            expectSee(await browser.get('/two-factor-challenge').expect(200), 'Two-Factor Authentication')
        })

        it('accepts a valid code', async () => {
            const secret = decryptSecret(await admin())!
            await Cache.flush()
            const browser = await challenged()
            expect(redirectPath(await browser.post('/two-factor-challenge', { code: currentCode(secret) }))).toBe('/dashboard')
            expect(await browser.isAuthenticated()).toBe(true)
        })

        it('rejects an invalid code', async () => {
            const response = await (await challenged()).post('/two-factor-challenge', { code: '000000' })
            expect(response.status).toBe(302)
            expect(Object.keys(flashedErrors(response)).length).toBeGreaterThan(0)
        })

        it('accepts a recovery code once', async () => {
            const [code] = recoveryCodes(await admin())
            const first = await challenged()
            expect(redirectPath(await first.post('/two-factor-challenge', { recovery_code: code }))).toBe('/dashboard')
            expect(await first.isAuthenticated()).toBe(true)
            const reused = await (await challenged()).post('/two-factor-challenge', { recovery_code: code })
            expect(reused.status).toBe(302)
            expect(Object.keys(flashedErrors(reused)).length).toBeGreaterThan(0)
        })

        it('rejects an invalid recovery code', async () => {
            const response = await (await challenged()).post('/two-factor-challenge', { recovery_code: 'invalid-code' })
            expect(response.status).toBe(302)
            expect(Object.keys(flashedErrors(response)).length).toBeGreaterThan(0)
        })
    })

    it('lets users without it sign in normally', async () => {
        const browser = agent()
        expect(redirectPath(await browser.post('/login', { email: 'admin@example.com', password: 'admin' }))).toBe('/dashboard')
        expect(await browser.isAuthenticated()).toBe(true)
        expect((await admin()).last_ip).toMatch(/127\.0\.0\.1$/)
    })

    describe('password confirmation', () => {
        it('answers JSON requests with 201 or 422', async () => {
            const as = actingAs(await admin())
            await as.postJson('/user/confirm-password', { password: 'admin' }).set('Accept', 'application/json').expect(201)
            await as.postJson('/user/confirm-password', { password: 'wrong' }).set('Accept', 'application/json').expect(422)
        })

        it('is needed to enable or disable two-factor authentication', async () => {
            expect(redirectPath(await actingAs(await admin()).post('/user/two-factor-authentication'))).toBe('/user/confirm-password')
            await enableAndConfirm()
            expect(redirectPath(await actingAs(await admin()).delete('/user/two-factor-authentication'))).toBe('/user/confirm-password')
            expect((await admin()).two_factor_secret).not.toBeNull()
        })
    })

    describe('resetting it for someone else', () => {
        let target: User
        beforeEach(async () => {
            target = await makeUser({}, { email: 'test2fa@example.com', username: 'testuser2fa' })
            await enableAndConfirm('test2fa@example.com', 'password')
        })

        it('is allowed for a superadmin', async () => {
            expect(redirectPath(await actingAs(await admin()).post(`/user/${target.id}/reset-2fa`))).toBe(`/user/edit/${target.id}`)
            expect(await fresh(target)).toMatchObject({ two_factor_secret: null, two_factor_confirmed_at: null })
        })

        it('is allowed for a user manager', async () => {
            const manager = await makeUser({ solder_users: true })
            expect(redirectPath(await actingAs(manager).post(`/user/${target.id}/reset-2fa`))).toBe(`/user/edit/${target.id}`)
            expect((await fresh(target)).two_factor_secret).toBeNull()
        })

        it('is not allowed for a regular user', async () => {
            expect(redirectPath(await actingAs(await makeUser()).post(`/user/${target.id}/reset-2fa`))).toBe('/dashboard')
        })
    })

    it('shows two-factor status in the user list', async () => {
        expect((await actingAs(await admin()).get('/user/list').expect(200)).text).toContain('two_factor')
    })

    it('is not reachable by guests', async () => {
        expect(redirectPath(await client().post('/user/two-factor-authentication'))).toBe('/login')
    })
})
