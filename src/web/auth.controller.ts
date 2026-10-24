import { Controller, Delete, Get, Post, Req, Res, UseGuards } from '@nestjs/common'
import type { Request, Response } from 'express'
import { resetPassword, RESET_MESSAGES, sendResetLink } from '../auth/password-reset.js'
import { hashPassword, needsRehash, verifyPassword } from '../auth/passwords.js'
import {
    confirmTwoFactor,
    decryptSecret,
    disableTwoFactor,
    enableTwoFactor,
    hasEnabledTwoFactor,
    qrCodeSvg,
    qrCodeUrl,
    recoveryCodes,
    regenerateRecoveryCodes,
    useRecoveryCode,
    verifyCode,
} from '../auth/two-factor.js'
import { config } from '../config.js'
import { db } from '../database/prisma.js'
import { setCurrentUserId } from '../http/context.js'
import { abort, ValidationError } from '../http/errors.js'
import { AuthGuard, GuestGuard } from '../http/guards.js'
import { clearAttempts, throttle } from '../http/rate-limit.js'
import { Web } from '../http/web.js'
import { permissionFor } from '../models/relations.js'
import { getUpdateCheck } from '../services/update-utils.js'
import { Cache, HOUR } from '../support/cache.js'
import { logger } from '../support/logger.js'
import { random, transliterateLower } from '../support/str.js'
import { Rule, validate } from '../support/validation.js'

/** Seconds a password confirmation lasts (fortify password_timeout) */
const PASSWORD_TIMEOUT = 10800

const HOME = 'dashboard'

/** How long "Remember me" keeps a session */
const REMEMBER_DAYS = 5 * 365

function regenerate(req: Request): Promise<void> {
    return new Promise((resolve, reject) => req.session.regenerate((error) => (error ? reject(error) : resolve())))
}

/**
 * Sign the user in: a new session (against fixation), their IP recorded, and the update banner refreshed in the
 * background for superadmins (Laravel's Login event listener).
 */
async function login(web: Web, userId: number, remember = false): Promise<void> {
    const intended = web.session.intended
    await regenerate(web.req)
    web.session.userId = userId
    web.session.passwordConfirmedAt = Math.floor(Date.now() / 1000)
    if (intended) {
        web.session.intended = intended
    }
    if (remember) {
        // "Remember me" keeps the session for five years instead of SESSION_LIFETIME
        web.session.cookie.maxAge = REMEMBER_DAYS * 86_400_000
    }
    await db.user.update({ where: { id: userId }, data: { last_ip: web.ip(), ...(remember ? { remember_token: random(60) } : {}) } })
    setCurrentUserId(userId)
    void (async () => {
        try {
            const permission = await permissionFor(userId)
            if (permission?.solder_full && (await getUpdateCheck())) {
                await Cache.put('update', true, HOUR)
            }
        } catch (error) {
            logger.report(error)
        }
    })()
}

function redirectIntended(web: Web): void {
    const intended = web.session.intended
    delete web.session.intended
    web.redirect(intended ?? HOME).send()
}

function requireMail(): void {
    if (!config.solder.mail_enabled) {
        abort(404)
    }
}

/** Two-factor setup and similar account changes need a recent password confirmation */
function requirePasswordConfirmation(web: Web): boolean {
    const confirmedAt = web.session.passwordConfirmedAt ?? 0
    if (Math.floor(Date.now() / 1000) - confirmedAt < PASSWORD_TIMEOUT) {
        return true
    }
    if (web.expectsJson()) {
        web.json({ message: 'Password confirmation required.' }, 423)
    } else {
        web.session.intended = web.req.get('Referer') ?? web.req.originalUrl
        web.redirect('user/confirm-password').send()
    }
    return false
}

/** Back to the previous page with a status, or 200/204 for JSON requests (Fortify's responses) */
function backWithStatus(web: Web, status: string, jsonStatus = 200): void {
    if (web.expectsJson()) {
        web.res.status(jsonStatus).end()
        return
    }
    web.back().with('status', status).send()
}

/**
 * Sign in, two-factor authentication, password confirmation and password resets, as Laravel Fortify did.
 */
@Controller()
export class AuthController {
    @Get()
    root(@Req() req: Request, @Res() res: Response): void {
        Web.of(req, res).redirect('dashboard').send()
    }

    @Get('login')
    @UseGuards(GuestGuard)
    async showLogin(@Req() req: Request, @Res() res: Response): Promise<void> {
        await Web.of(req, res).view('dashboard.login')
    }

    @Post('login')
    @UseGuards(GuestGuard)
    async login(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const email = web.string('email').toLowerCase()
        await throttle(`login:${transliterateLower(email)}|${web.ip()}`, 5, 60)
        const result = await validate({ ...web.all(), email }, { email: 'required|string', password: 'required|string' })
        if (!result.passes) {
            throw new ValidationError(result.errors, 'login')
        }
        const user = await db.user.findFirst({ where: { email } })
        if (!user || !(await verifyPassword(web.string('password'), user.password))) {
            throw new ValidationError({ email: ['These credentials do not match our records.'] }, 'login')
        }
        // Upgrade hashes made with a different work factor (Laravel rehashes on login)
        if (needsRehash(user.password)) {
            await db.user.update({ where: { id: user.id }, data: { password: await hashPassword(web.string('password')) } })
        }
        if (hasEnabledTwoFactor(user)) {
            web.session.loginId = user.id
            web.session.loginRemember = web.boolean('remember')
            web.redirect('two-factor-challenge').send()
            return
        }
        await login(web, user.id, web.boolean('remember'))
        redirectIntended(web)
    }

    @Get('two-factor-challenge')
    @UseGuards(GuestGuard)
    async showTwoFactorChallenge(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        if (web.session.loginId === undefined) {
            web.redirect('login').send()
            return
        }
        await web.view('auth.two-factor-challenge')
    }

    @Post('two-factor-challenge')
    @UseGuards(GuestGuard)
    async twoFactorChallenge(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        const userId = web.session.loginId
        const user = userId === undefined ? null : await db.user.findUnique({ where: { id: userId } })
        if (!user) {
            web.redirect('login').send()
            return
        }
        await throttle(`two-factor:${userId}`, 5, 60)
        const recovery = web.string('recovery_code')
        if (recovery !== '') {
            if (!(await useRecoveryCode(user, recovery))) {
                throw new ValidationError({ recovery_code: ['The provided two factor recovery code was invalid.'] }, 'two-factor-challenge')
            }
        } else {
            const secret = decryptSecret(user)
            if (secret === null || !(await verifyCode(secret, web.string('code')))) {
                throw new ValidationError({ code: ['The provided two factor authentication code was invalid.'] }, 'two-factor-challenge')
            }
        }
        delete web.session.loginId
        delete web.session.loginRemember
        const remember = web.session.loginRemember ?? false
        await clearAttempts(`two-factor:${userId}`)
        await login(web, user.id, remember)
        redirectIntended(web)
    }

    @Post('logout')
    @UseGuards(AuthGuard)
    async logout(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        await regenerate(req)
        req.user = null
        web.redirect('login').with('status', 'You have been logged out.').send()
    }

    @Get('forgot-password')
    @UseGuards(GuestGuard)
    async showForgotPassword(@Req() req: Request, @Res() res: Response): Promise<void> {
        requireMail()
        await Web.of(req, res).view('auth.forgot-password')
    }

    @Post('forgot-password')
    @UseGuards(GuestGuard)
    async forgotPassword(@Req() req: Request, @Res() res: Response): Promise<void> {
        requireMail()
        const web = Web.of(req, res)
        const result = await validate(web.all(), { email: 'required|email' })
        if (!result.passes) {
            throw new ValidationError(result.errors)
        }
        const status = await sendResetLink(web.string('email'))
        if (status !== 'passwords.sent') {
            throw new ValidationError({ email: [RESET_MESSAGES[status]] })
        }
        web.back().with('status', RESET_MESSAGES[status]).send()
    }

    @Get('reset-password/:token')
    @UseGuards(GuestGuard)
    async showResetPassword(@Req() req: Request, @Res() res: Response): Promise<void> {
        requireMail()
        const web = Web.of(req, res)
        await web.view('auth.reset-password', { token: req.params.token, email: web.query('email') })
    }

    @Post('reset-password')
    @UseGuards(GuestGuard)
    async resetPassword(@Req() req: Request, @Res() res: Response): Promise<void> {
        requireMail()
        const web = Web.of(req, res)
        const result = await validate(web.all(), {
            token: 'required',
            email: 'required|email',
            password: ['required', 'string', Rule.password(), 'confirmed'],
        })
        if (!result.passes) {
            throw new ValidationError(result.errors)
        }
        const status = await resetPassword(web.string('email'), web.string('token'), web.string('password'))
        if (status !== 'passwords.reset') {
            web.back().withInput({ email: web.input('email') }).withErrors({ email: RESET_MESSAGES[status] }).send()
            return
        }
        web.redirect('login').with('status', RESET_MESSAGES[status]).send()
    }

    @Get('user/confirm-password')
    @UseGuards(AuthGuard)
    async showConfirmPassword(@Req() req: Request, @Res() res: Response): Promise<void> {
        await Web.of(req, res).view('auth.confirm-password')
    }

    @Post('user/confirm-password')
    @UseGuards(AuthGuard)
    async confirmPassword(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        if (!(await verifyPassword(web.string('password'), web.user.password))) {
            if (web.expectsJson()) {
                web.json({ message: 'The provided password was incorrect.', errors: { password: ['The provided password was incorrect.'] } }, 422)
                return
            }
            web.back().withErrors({ password: 'The provided password was incorrect.' }).send()
            return
        }
        web.session.passwordConfirmedAt = Math.floor(Date.now() / 1000)
        if (web.expectsJson()) {
            web.res.status(201).end()
            return
        }
        redirectIntended(web)
    }

    @Get('user/confirmed-password-status')
    @UseGuards(AuthGuard)
    confirmedPasswordStatus(@Req() req: Request, @Res() res: Response): void {
        const web = Web.of(req, res)
        const confirmedAt = web.session.passwordConfirmedAt ?? 0
        web.json({ confirmed: Math.floor(Date.now() / 1000) - confirmedAt < PASSWORD_TIMEOUT })
    }

    @Post('user/two-factor-authentication')
    @UseGuards(AuthGuard)
    async enableTwoFactor(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        if (!requirePasswordConfirmation(web)) {
            return
        }
        await enableTwoFactor(web.userId, web.boolean('force'))
        backWithStatus(web, 'two-factor-authentication-enabled')
    }

    @Post('user/confirmed-two-factor-authentication')
    @UseGuards(AuthGuard)
    async confirmTwoFactor(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        if (!requirePasswordConfirmation(web)) {
            return
        }
        if (!(await confirmTwoFactor(web.userId, web.string('code')))) {
            if (web.expectsJson()) {
                web.json({ message: 'The provided two factor authentication code was invalid.', errors: { code: ['The provided two factor authentication code was invalid.'] } }, 422)
                return
            }
            web.back().withErrors({ code: 'The provided two factor authentication code was invalid.' }).send()
            return
        }
        backWithStatus(web, 'two-factor-authentication-confirmed')
    }

    @Delete('user/two-factor-authentication')
    @UseGuards(AuthGuard)
    async disableTwoFactor(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        if (!requirePasswordConfirmation(web)) {
            return
        }
        await disableTwoFactor(web.userId)
        backWithStatus(web, 'two-factor-authentication-disabled')
    }

    @Get('user/two-factor-qr-code')
    @UseGuards(AuthGuard)
    async qrCode(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        if (!requirePasswordConfirmation(web)) {
            return
        }
        const user = web.user
        if (user.two_factor_secret === null) {
            web.json([])
            return
        }
        web.json({ svg: await qrCodeSvg(user), url: qrCodeUrl(user) })
    }

    @Get('user/two-factor-secret-key')
    @UseGuards(AuthGuard)
    secretKey(@Req() req: Request, @Res() res: Response): void {
        const web = Web.of(req, res)
        if (!requirePasswordConfirmation(web)) {
            return
        }
        if (web.user.two_factor_secret === null) {
            abort(404, 'Two factor authentication has not been enabled.')
        }
        web.json({ secretKey: decryptSecret(web.user) })
    }

    @Get('user/two-factor-recovery-codes')
    @UseGuards(AuthGuard)
    recoveryCodes(@Req() req: Request, @Res() res: Response): void {
        const web = Web.of(req, res)
        if (!requirePasswordConfirmation(web)) {
            return
        }
        const user = web.user
        web.json(user.two_factor_secret === null || user.two_factor_recovery_codes === null ? [] : recoveryCodes(user))
    }

    @Post('user/two-factor-recovery-codes')
    @UseGuards(AuthGuard)
    async regenerateRecoveryCodes(@Req() req: Request, @Res() res: Response): Promise<void> {
        const web = Web.of(req, res)
        if (!requirePasswordConfirmation(web)) {
            return
        }
        await regenerateRecoveryCodes(web.userId)
        backWithStatus(web, 'recovery-codes-generated')
    }
}
