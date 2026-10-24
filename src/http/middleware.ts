import { tmpdir } from 'node:os'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import session from 'express-session'
import multer from 'multer'
import { findToken } from '../auth/tokens.js'
import { config, isTesting } from '../config.js'
import { findUserWithPermission } from '../models/relations.js'
import { redis } from '../support/cache.js'
import { random } from '../support/str.js'
import { runWithContext, setCurrentUserId } from './context.js'
import { TokenMismatchError } from './errors.js'
import { hit } from './rate-limit.js'
import { RedisSessionStore } from './session-store.js'
import { UploadedFile } from './uploaded-file.js'

/** Security headers on every response */
export const securityHeaders: RequestHandler = (_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    next()
}

/** Make the current user and host available to code that runs during the request */
export const requestContext: RequestHandler = (req, _res, next) => {
    runWithContext({ userId: null, baseUrl: `${req.protocol}://${req.get('host')}` }, () => next())
}

/** Uploaded files go to temporary files */
export const multipart: RequestHandler = multer({ dest: tmpdir(), limits: { fileSize: 1024 * 1024 * 1024 } }).any()

const UNTRIMMED = ['current_password', 'password', 'password_confirmation']

/** Laravel's TrimStrings and ConvertEmptyStringsToNull, applied to nested input */
function normalize(value: unknown, key: string): unknown {
    if (typeof value === 'string') {
        const trimmed = UNTRIMMED.includes(key) ? value : value.trim()
        return trimmed === '' ? null : trimmed
    }
    if (Array.isArray(value)) {
        return value.map((item) => normalize(item, key))
    }
    if (value !== null && typeof value === 'object' && !(value instanceof UploadedFile)) {
        return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [childKey, normalize(item, childKey)]))
    }
    return value
}

/** Assign a value at a "files[0]" / "files[]" style field name */
function assignField(target: Record<string, unknown>, field: string, value: unknown): void {
    const match = /^([^[]+)((?:\[[^\]]*\])*)$/.exec(field)
    if (!match) {
        target[field] = value
        return
    }
    const segments = [match[1], ...[...match[2].matchAll(/\[([^\]]*)\]/g)].map((m) => m[1])]
    let current: Record<string, unknown> | unknown[] = target
    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i]
        const last = i === segments.length - 1
        if (Array.isArray(current)) {
            if (last) {
                current.push(value)
                return
            }
            const next: Record<string, unknown> = {}
            current.push(next)
            current = next
            continue
        }
        if (last) {
            current[segment] = value
            return
        }
        const nextIsList = segments[i + 1] === ''
        current[segment] ??= nextIsList ? [] : {}
        current = current[segment] as Record<string, unknown> | unknown[]
    }
}

/** Merge query, body and files into req.input */
export const normalizeInput: RequestHandler = (req, _res, next) => {
    const input: Record<string, unknown> = { ...(req.query as Record<string, unknown>) }
    if (req.body !== null && typeof req.body === 'object' && !Array.isArray(req.body)) {
        Object.assign(input, req.body)
    }
    const normalized = normalize(input, '') as Record<string, unknown>
    for (const file of (req.files as Express.Multer.File[] | undefined) ?? []) {
        assignField(normalized, file.fieldname, new UploadedFile(file.path, file.originalname, file.size, file.mimetype))
    }
    req.input = normalized
    next()
}

export function sessionMiddleware(): RequestHandler {
    return session({
        name: config.session.cookie,
        secret: config.app.key || 'solder-insecure-development-secret',
        resave: false,
        saveUninitialized: false,
        rolling: true,
        store: config.session.driver === 'redis' ? new RedisSessionStore(redis()) : undefined,
        cookie: {
            httpOnly: true,
            sameSite: 'lax',
            secure: config.session.secure,
            maxAge: config.session.lifetimeMinutes * 60 * 1000,
        },
    })
}

/** Move last request's flash data into req.flash, and make sure the session has a CSRF token */
export const flashAndToken: RequestHandler = (req, _res, next) => {
    req.flash = req.session._flash ?? {}
    delete req.session._flash
    req.session._token ??= random(40)
    next()
}

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS']

/** Laravel's CSRF protection: _token field or X-CSRF-TOKEN header must match the session (skipped in tests) */
export const verifyCsrfToken: RequestHandler = (req, _res, next) => {
    if (SAFE_METHODS.includes(req.method) || isTesting()) {
        next()
        return
    }
    const token = (req.input?._token as string | undefined) ?? req.get('X-CSRF-TOKEN') ?? req.get('X-XSRF-TOKEN')
    if (!token || token !== req.session._token) {
        next(new TokenMismatchError())
        return
    }
    next()
}

/** Load the signed-in user from the session */
export const loadSessionUser: RequestHandler = async (req, _res, next) => {
    try {
        req.user = null
        // Tests sign in with a header (Laravel's actingAs); never honored outside APP_ENV=testing
        const testingUser = isTesting() ? req.get('X-Testing-User') : undefined
        if (testingUser !== undefined && /^\d+$/.test(testingUser)) {
            req.session.userId = Number(testingUser)
        }
        if (req.session.userId !== undefined) {
            req.user = await findUserWithPermission(req.session.userId)
            if (req.user === null) {
                delete req.session.userId
            }
        }
        setCurrentUserId(req.user?.id ?? null)
        next()
    } catch (error) {
        next(error)
    }
}

/** API responses are always JSON */
export const forceJson: RequestHandler = (req, _res, next) => {
    req.headers.accept = 'application/json'
    next()
}

/** CORS for the launcher API (SOLDER_CORS_ORIGINS) */
export const cors: RequestHandler = (req, res, next) => {
    const allowed = config.solder.cors_allowed_origins || '*'
    const setHeaders = () => {
        if (allowed === '*') {
            res.setHeader('Access-Control-Allow-Origin', '*')
            return
        }
        const origin = req.get('Origin')
        if (origin && allowed.split(',').map((value) => value.trim()).includes(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin)
        }
        res.setHeader('Vary', 'Origin')
    }
    setHeaders()
    next()
}

/** Authenticate a bearer token (Sanctum) */
export const loadTokenUser: RequestHandler = async (req, _res, next) => {
    try {
        req.user = null
        const header = req.get('Authorization') ?? ''
        const match = /^Bearer\s+(.+)$/i.exec(header)
        if (match) {
            const token = await findToken(match[1].trim())
            if (token) {
                req.user = await findUserWithPermission(token.tokenable_id)
            }
        }
        setCurrentUserId(req.user?.id ?? null)
        next()
    } catch (error) {
        next(error)
    }
}

/** throttleApi(): 60 requests a minute per user (or IP) */
export const throttleApi: RequestHandler = async (req, res, next) => {
    try {
        const key = `api:${req.user?.id ?? req.ip}`
        const result = await hit(key, 60, 60)
        res.setHeader('X-RateLimit-Limit', '60')
        res.setHeader('X-RateLimit-Remaining', String(result.remaining))
        if (!result.allowed) {
            res.setHeader('Retry-After', String(result.retryAfter))
            res.status(429).json({ message: 'Too Many Attempts.' })
            return
        }
        next()
    } catch (error) {
        next(error)
    }
}

export function isApiRequest(req: Request): boolean {
    return req.path === '/api' || req.path.startsWith('/api/')
}

/** Run web-only middleware on web routes and API-only middleware on /api routes */
export function split(web: RequestHandler[], api: RequestHandler[]): RequestHandler {
    const run = (handlers: RequestHandler[], req: Request, res: Response, next: NextFunction) => {
        let index = 0
        const step = (error?: unknown): void => {
            if (error !== undefined && error !== null && error !== 'route') {
                next(error)
                return
            }
            const handler = handlers[index++]
            if (!handler) {
                next()
                return
            }
            try {
                const result = handler(req, res, step) as unknown
                if (result instanceof Promise) {
                    result.catch(next)
                }
            } catch (caught) {
                next(caught)
            }
        }
        step()
    }
    return (req, res, next) => run(isApiRequest(req) ? api : web, req, res, next)
}
