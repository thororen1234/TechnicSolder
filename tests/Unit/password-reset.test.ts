import { config } from '../../src/config.js'
import { Mail } from '../../src/support/mail.js'
import { agent, client, expectDontSee, expectSee, flashed, flashedErrors, redirectPath, useSolder } from '../support/helpers.js'

describe('Password resets', () => {
    useSolder()
    const enableMail = () => {
        config.solder.mail_enabled = true
    }

    it('are unavailable while mail is disabled', async () => {
        await client().get('/forgot-password').expect(404)
        await client().post('/forgot-password', { email: 'admin@example.com' }).expect(404)
        expectDontSee(await client().get('/login'), 'Forgot password?')
    })

    it('are offered when mail is enabled', async () => {
        enableMail()
        expectSee(await client().get('/forgot-password').expect(200), 'Send Reset Link')
        expectSee(await client().get('/login'), 'Forgot password?')
    })

    it('email a link for a known address only', async () => {
        enableMail()
        const sent = await client().post('/forgot-password', { email: 'admin@example.com' })
        expect(sent.status).toBe(302)
        expect(flashed(sent)).toHaveProperty('status')
        expect(Mail.sent().map((mail) => mail.to)).toEqual(['admin@example.com'])
        Mail.reset()
        expect((await client().post('/forgot-password', { email: 'nobody@example.com' })).status).toBe(302)
        expect(Mail.sent()).toHaveLength(0)
    })

    it('reset the password with the emailed token', async () => {
        enableMail()
        await client().post('/forgot-password', { email: 'admin@example.com' })
        const token = /reset-password\/([^?\s"]+)/.exec(Mail.sent()[0].text)![1]
        const response = await client().post('/reset-password', {
            token,
            email: 'admin@example.com',
            password: 'new-password-123',
            password_confirmation: 'new-password-123',
        })
        expect(redirectPath(response)).toBe('/login')
        const browser = agent()
        await browser.post('/login', { email: 'admin@example.com', password: 'new-password-123' })
        expect(await browser.isAuthenticated()).toBe(true)
    })

    it('reject an invalid token', async () => {
        enableMail()
        const response = await client().post('/reset-password', {
            token: 'invalid-token',
            email: 'admin@example.com',
            password: 'new-password-123',
            password_confirmation: 'new-password-123',
        })
        expect(response.status).toBe(302)
        expect(flashedErrors(response)).toHaveProperty('email')
    })

    it('show the reset form', async () => {
        enableMail()
        expectSee(await client().get('/reset-password/test-token').expect(200), 'Set New Password')
    })
})
