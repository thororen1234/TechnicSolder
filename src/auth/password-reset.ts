import { createHmac } from 'node:crypto'
import { config } from '../config.js'
import { db } from '../database/prisma.js'
import { route } from '../http/urls.js'
import { sendMail } from '../support/mail.js'
import { random } from '../support/str.js'
import { hashPassword, verifyPassword } from './passwords.js'

/**
 * Password reset links, like Laravel's password broker: a random token emailed to the user and stored hashed in
 * password_reset_tokens, valid for an hour, at most one email a minute.
 */
const EXPIRE_MINUTES = 60
const THROTTLE_SECONDS = 60

export type ResetStatus = 'passwords.sent' | 'passwords.user' | 'passwords.throttled' | 'passwords.token' | 'passwords.reset'

export const RESET_MESSAGES: Record<ResetStatus, string> = {
    'passwords.sent': 'We have emailed your password reset link.',
    'passwords.user': "We can't find a user with that email address.",
    'passwords.throttled': 'Please wait before retrying.',
    'passwords.token': 'This password reset token is invalid.',
    'passwords.reset': 'Your password has been reset.',
}

function newToken(): string {
    return createHmac('sha256', config.app.key || 'solder').update(random(40)).digest('hex')
}

async function findUser(email: string) {
    return db.user.findFirst({ where: { email } })
}

export async function sendResetLink(email: string): Promise<ResetStatus> {
    const user = await findUser(email)
    if (!user) {
        return 'passwords.user'
    }
    const existing = await db.passwordResetToken.findUnique({ where: { email: user.email } })
    if (existing?.created_at && existing.created_at.getTime() + THROTTLE_SECONDS * 1000 > Date.now()) {
        return 'passwords.throttled'
    }
    const token = newToken()
    const hashed = await hashPassword(token)
    await db.passwordResetToken.upsert({
        where: { email: user.email },
        create: { email: user.email, token: hashed, created_at: new Date() },
        update: { token: hashed, created_at: new Date() },
    })
    const url = route('password.reset', { token, email: user.email })
    await sendMail({
        to: user.email,
        subject: 'Reset Password Notification',
        text: [
            'Hello!',
            '',
            'You are receiving this email because we received a password reset request for your account.',
            '',
            `Reset Password: ${url}`,
            '',
            `This password reset link will expire in ${EXPIRE_MINUTES} minutes.`,
            '',
            'If you did not request a password reset, no further action is required.',
        ].join('\n'),
        html: `<p>Hello!</p><p>You are receiving this email because we received a password reset request for your account.</p><p><a href="${url}">Reset Password</a></p><p>This password reset link will expire in ${EXPIRE_MINUTES} minutes.</p><p>If you did not request a password reset, no further action is required.</p>`,
    })
    return 'passwords.sent'
}

export async function resetPassword(email: string, token: string, password: string): Promise<ResetStatus> {
    const user = await findUser(email)
    if (!user) {
        return 'passwords.user'
    }
    const record = await db.passwordResetToken.findUnique({ where: { email: user.email } })
    const expired = !record?.created_at || record.created_at.getTime() + EXPIRE_MINUTES * 60_000 < Date.now()
    if (!record || expired || !(await verifyPassword(token, record.token))) {
        return 'passwords.token'
    }
    await db.user.update({ where: { id: user.id }, data: { password: await hashPassword(password), remember_token: random(60) } })
    await db.passwordResetToken.delete({ where: { email: user.email } })
    return 'passwords.reset'
}
