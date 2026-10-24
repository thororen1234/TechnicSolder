import type { Request, Response } from 'express'
import type { Session, SessionData } from 'express-session'
import { isTesting } from '../config.js'
import { db } from '../database/prisma.js'
import { canAccessModpack } from '../models/permissions.js'
import type { UserWithPermission } from '../models/types.js'
import { Cache, MINUTE } from '../support/cache.js'
import { naturalCompare } from '../support/str.js'
import type { ErrorBag } from '../support/validation.js'
import { render } from '../views/view.js'
import { abort } from './errors.js'
import { UploadedFile } from './uploaded-file.js'
import { appUrl } from './urls.js'

declare module 'express-session' {
    interface SessionData {
        userId?: number
        _token?: string
        /** Flash data for the next request */
        _flash?: Record<string, unknown>
        /** Where to go after logging in */
        intended?: string
        /** User waiting for their two-factor code */
        loginId?: number
        loginRemember?: boolean
        /** When the user last confirmed their password (seconds) */
        passwordConfirmedAt?: number
    }
}

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            /** Body, query and files merged, after trimming and empty strings becoming null */
            input: Record<string, unknown>
            /** The signed-in user (web session) or the token's user (API) */
            user?: UserWithPermission | null
            /** Flash data received from the previous request */
            flash: Record<string, unknown>
            web?: Web
        }
    }
}

type Session_ = Session & Partial<SessionData>

/** The last view rendered, for tests (Laravel's assertViewHas) */
export const testing: { lastView: { name: string; data: Record<string, unknown> } | null } = { lastView: null }

const ACCEPTED = ['1', 'true', 'on', 'yes']

/**
 * A request and its response with Laravel's conveniences: input(), boolean(), redirect()->with(), view()...
 */
export class Web {
    constructor(
        readonly req: Request,
        readonly res: Response,
    ) {}

    static of(req: Request, res: Response): Web {
        req.web ??= new Web(req, res)
        return req.web
    }

    get session(): Session_ {
        return this.req.session as Session_
    }

    /** The signed-in user; only call on routes behind the auth guard */
    get user(): UserWithPermission {
        if (!this.req.user) {
            throw new Error('No user is signed in')
        }
        return this.req.user
    }

    get userId(): number {
        return this.user.id
    }

    all(): Record<string, unknown> {
        return this.req.input
    }

    input<T = unknown>(key: string, fallback: T | null = null): T | null {
        let value: unknown = this.req.input
        for (const segment of key.split('.')) {
            value = value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[segment] : undefined
        }
        return value === undefined || value === null ? fallback : (value as T)
    }

    /** The input as a string ('' when missing) */
    string(key: string, fallback = ''): string {
        const value = this.input(key)
        return value === null || typeof value === 'object' ? fallback : String(value)
    }

    has(key: string): boolean {
        return key in this.req.input
    }

    /** Present and not an empty string */
    filled(key: string): boolean {
        const value = this.input(key)
        return value !== null && !(typeof value === 'string' && value.trim() === '') && !(Array.isArray(value) && value.length === 0)
    }

    /** $request->boolean(): "1", "true", "on" and "yes" are true */
    boolean(key: string): boolean {
        const value = this.input(key)
        return value === true || ACCEPTED.includes(String(value ?? '').toLowerCase())
    }

    query(key: string, fallback: string | null = null): string | null {
        const value = this.req.query[key]
        return typeof value === 'string' ? value : fallback
    }

    /** Array input, as (array) Request::input() */
    array(key: string): unknown[] {
        const value = this.input(key)
        if (value === null) {
            return []
        }
        if (Array.isArray(value)) {
            return value
        }
        return typeof value === 'object' && !(value instanceof UploadedFile) ? Object.values(value) : [value]
    }

    file(key: string): UploadedFile | null {
        const value = this.input(key)
        return value instanceof UploadedFile ? value : null
    }

    files(key: string): UploadedFile[] {
        return this.array(key).filter((value): value is UploadedFile => value instanceof UploadedFile)
    }

    ip(): string {
        return this.req.ip ?? ''
    }

    /** Request::ajax() */
    ajax(): boolean {
        return this.req.get('X-Requested-With') === 'XMLHttpRequest'
    }

    /** Laravel's expectsJson(): an AJAX request that accepts anything, or one that asks for JSON */
    expectsJson(): boolean {
        const accept = (this.req.get('Accept') ?? '').trim()
        const first = accept.split(',')[0]?.split(';')[0]?.trim() ?? ''
        const acceptsAnyContentType = accept === '' || first === '*/*' || first === '*'
        return (this.ajax() && !this.req.get('X-PJAX') && acceptsAnyContentType) || /\/json|\+json/.test(first)
    }

    /** abort(404) unless the request came from fetch()/XHR */
    requireAjax(): void {
        if (!this.ajax()) {
            abort(404)
        }
    }

    /** Remember something for the next request only */
    flash(key: string, value: unknown): void {
        this.session._flash = { ...(this.session._flash ?? {}), [key]: value }
    }

    redirect(path: string): Redirect {
        return new Redirect(this, appUrl(path))
    }

    back(): Redirect {
        return new Redirect(this, this.req.get('Referer') ?? appUrl('/'))
    }

    async view(name: string, data: Record<string, unknown> = {}, status = 200, errors: ErrorBag | null = null): Promise<void> {
        if (isTesting()) {
            testing.lastView = { name, data }
        }
        const html = await render(name, data, {
            user: this.req.user ?? null,
            csrfToken: this.session?._token ?? '',
            flash: this.req.flash ?? {},
            errors: errors ?? ((this.req.flash?.errors as Record<string, string[]> | undefined) ?? {}),
            oldInput: (this.req.flash?._old_input as Record<string, unknown> | undefined) ?? {},
            layout: this.req.user ? await layoutData(this.req.user) : {},
            previousUrl: this.req.get('Referer'),
            currentUrl: appUrl(this.req.path),
            input: this.req.input,
        })
        this.res.status(status).type('html').send(html)
    }

    json(data: unknown, status = 200): void {
        this.res.status(status).json(data)
    }

    download(path: string, filename: string): Promise<void> {
        return new Promise((resolve, reject) => this.res.download(path, filename, (error) => (error ? reject(error) : resolve())))
    }

    /** response()->streamDownload() for content generated in memory */
    streamDownload(contents: string | Buffer, filename: string, contentType: string): void {
        // The headers Symfony sends: a charset for text types, the file name quoted only when it needs to be
        const quoted = /^[\w.!#$%&'*+^`|~-]+$/.test(filename) ? filename : `"${filename.replace(/["\\]/g, '\\$&')}"`
        this.res
            .status(200)
            .setHeader('Content-Type', contentType.startsWith('text/') ? `${contentType}; charset=UTF-8` : contentType)
            .setHeader('Content-Disposition', `attachment; filename=${quoted}`)
            .end(contents)
    }

    /** The input is truthy the way PHP sees it ("0", "" and null are not) */
    truthy(key: string): boolean {
        const value = this.input(key)
        return !(value === null || value === false || value === 0 || value === '0' || value === '' || (Array.isArray(value) && value.length === 0))
    }
}

/** redirect(): chain with(), withErrors() and withInput(), then send() */
export class Redirect {
    private flashData: Record<string, unknown> = {}

    constructor(
        private readonly web: Web,
        private readonly url: string,
    ) {}

    with(key: string, value: unknown): this {
        this.flashData[key] = value
        return this
    }

    /** Errors as a list (keyed 0, 1...), a field => message map, or a validator's error bag */
    withErrors(errors: ErrorBag | string[] | Record<string, string | string[]>): this {
        const bag: ErrorBag = {}
        for (const [key, value] of Object.entries(errors)) {
            bag[key] = Array.isArray(value) ? value : [value]
        }
        this.flashData.errors = { ...((this.flashData.errors as ErrorBag) ?? {}), ...bag }
        return this
    }

    withInput(input?: Record<string, unknown>): this {
        const values = input ?? this.web.all()
        this.flashData._old_input = Object.fromEntries(Object.entries(values).filter(([, value]) => !(value instanceof UploadedFile)))
        return this
    }

    send(): void {
        for (const [key, value] of Object.entries(this.flashData)) {
            this.web.flash(key, value)
        }
        if (isTesting()) {
            // Lets tests assert on flashed data, like Laravel's assertSessionHas()
            this.web.res.setHeader('X-Testing-Flash', Buffer.from(JSON.stringify(this.flashData)).toString('base64'))
        }
        const finish = () => this.web.res.redirect(302, this.url)
        if (this.web.req.session) {
            this.web.req.session.save(() => finish())
        } else {
            finish()
        }
    }
}

/** View::composer('layouts.master'): the modpack rail and the update banner */
async function layoutData(user: UserWithPermission): Promise<Record<string, unknown>> {
    let modpacks = await Cache.remember('allmodpacks', MINUTE, async () =>
        (await db.modpack.findMany()).sort((a, b) => naturalCompare(a.name, b.name)),
    )
    if (!user.permission?.solder_full) {
        modpacks = modpacks.filter((modpack) => canAccessModpack(user.permission, modpack.id))
    }
    const updateAvailable = Boolean(await Cache.get('update'))
    return {
        railModpacks: modpacks,
        updateAvailable,
        /** Cache::get('update') in the layout */
        cacheGet: (key: string) => (key === 'update' ? updateAvailable : null),
    }
}
