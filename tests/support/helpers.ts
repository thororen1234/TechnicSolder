import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { createApp } from '../../src/app.js'
import { hashPassword } from '../../src/auth/passwords.js'
import { createToken } from '../../src/auth/tokens.js'
import { config, resetConfig } from '../../src/config.js'
import { connectDatabase, db } from '../../src/database/prisma.js'
import { migrate, TABLES } from '../../src/database/migrator.js'
import { testing } from '../../src/http/web.js'
import { Queue } from '../../src/jobs/queue.js'
import type { User, UserPermission } from '../../src/models/types.js'
import { Cache } from '../../src/support/cache.js'
import { Http } from '../../src/support/http.js'
import { Mail } from '../../src/support/mail.js'
import { ZipWriter } from '../../src/support/zip.js'

/**
 * The equivalent of Laravel's TestCase with RefreshDatabase: a fresh database (seeded like TestSeeder unless
 * `seed: false`), cache, config and fakes for every test, and an app to send requests to.
 */
let app: INestApplication | null = null

const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'

export function useSolder(options: { seed?: boolean } = {}): void {
    beforeAll(async () => {
        await migrate()
        await connectDatabase()
        app = await createApp()
        await app.init()
    })
    beforeEach(async () => {
        resetConfig()
        await resetDatabase()
        Cache.useMemoryStore()
        Http.reset()
        Mail.reset()
        Queue.reset()
        testing.lastView = null
        // No test may reach the network: GitHub (dashboard changelog) answers with nothing by default
        Http.fake({ 'api.github.com/*': { body: [] } })
        if (options.seed !== false) {
            await seedTestData()
        }
    })
    afterAll(async () => {
        await app?.close()
        app = null
    })
}

export async function resetDatabase(): Promise<void> {
    for (const table of TABLES) {
        await db.$executeRawUnsafe(`DELETE FROM ${table}`)
    }
    await db.$executeRawUnsafe(`DELETE FROM sqlite_sequence`).catch(() => undefined)
}

/** TestSeeder: an admin, TestModpack 1.0.0 with TestMod 1.0, Backtools, a client and a platform key */
export async function seedTestData(): Promise<void> {
    const admin = await db.user.create({
        data: { username: 'admin', email: 'admin@example.com', password: await hashPassword('admin'), created_ip: '127.0.0.1', last_ip: '127.0.0.1' },
    })
    await db.userPermission.create({ data: { user_id: admin.id, solder_full: true } })
    const modpack = await db.modpack.create({
        data: {
            name: 'TestModpack',
            slug: 'testmodpack',
            hidden: false,
            private: false,
            icon_url: 'http://localhost/resources/default/icon.png',
            logo_url: 'http://localhost/resources/default/logo.png',
            background_url: 'http://localhost/resources/default/background.jpg',
        },
    })
    const build = await db.build.create({
        data: { modpack_id: modpack.id, version: '1.0.0', minecraft: '1.7.10', min_java: '1.7', min_memory: 1024, is_published: true },
    })
    const mod = await db.mod.create({
        data: { pretty_name: 'TestMod', name: 'testmod', description: 'This is a test mod for Solder', author: 'Technic', link: 'http://solder.io' },
    })
    const modversion = await db.modversion.create({ data: { mod_id: mod.id, version: '1.0', md5: 'bdbc6c6cc48c7b037e4aef64b58258a3', filesize: 295 } })
    await db.mod.create({ data: { pretty_name: 'Backtools', name: 'backtools', link: 'http://ichun.us' } })
    await db.client.create({ data: { name: 'TestClient', uuid: '2ezf6f26-eb15-4ccb-9f0b-8z5ed2c72946' } })
    await db.key.create({ data: { name: 'TestKey', api_key: 'sfIvEcNueZtwKsTAIYOIYng1iuPAgavJsfIvEcNueZtwKsTAIYOIYng1iuPAgavJ' } })
    await db.buildModversion.create({ data: { build_id: build.id, modversion_id: modversion.id } })
}

type Permissions = Partial<Omit<UserPermission, 'id' | 'user_id' | 'modpacks'>> & { modpacks?: number[] }

/** A user with the given permissions (password "password") */
export async function makeUser(permissions: Permissions = {}, attributes: Partial<User> = {}): Promise<User> {
    const id = Math.random().toString(36).slice(2, 10)
    const user = await db.user.create({
        data: {
            username: `user${id}`,
            email: `user${id}@example.com`,
            password: await hashPassword('password'),
            created_ip: '127.0.0.1',
            ...attributes,
        },
    })
    const { modpacks, ...flags } = permissions
    await db.userPermission.create({ data: { user_id: user.id, ...flags, modpacks: modpacks?.length ? modpacks.join(',') : null } })
    return user
}

export async function admin(): Promise<User> {
    return db.user.findFirstOrThrow({ where: { email: 'admin@example.com' } })
}

export async function bearerToken(user: Pick<User, 'id'>): Promise<string> {
    return (await createToken(user, 'test')).plainTextToken
}

interface ClientOptions {
    /** Sign in as this user (web routes) */
    user?: Pick<User, 'id'> | null
    /** Send an API bearer token */
    token?: string
    /** Mark requests as AJAX (X-Requested-With) */
    ajax?: boolean
    headers?: Record<string, string>
}

/** Requests against the app, optionally signed in ($this->actingAs($user)) */
export function client(options: ClientOptions = {}) {
    if (!app) {
        throw new Error('Call useSolder() in the test file first')
    }
    const server = app.getHttpServer()
    // What Symfony's test requests (and browsers) send, so expectsJson() behaves as it did in the PHP tests
    const headers: Record<string, string> = { Accept: BROWSER_ACCEPT, ...(options.headers ?? {}) }
    if (options.user) {
        headers['X-Testing-User'] = String(options.user.id)
    }
    if (options.token) {
        headers.Authorization = `Bearer ${options.token}`
    }
    if (options.ajax) {
        headers['X-Requested-With'] = 'XMLHttpRequest'
    }
    const withHeaders = (test: request.Test) => test.set(headers)
    return {
        get: (url: string) => withHeaders(request(server).get(url)),
        post: (url: string, data?: object) => withHeaders(request(server).post(url)).type('form').send(formEncode(data ?? {})),
        postJson: (url: string, data?: object) => withHeaders(request(server).post(url)).send(data ?? {}),
        put: (url: string, data?: object) => withHeaders(request(server).put(url)).send(data ?? {}),
        delete: (url: string, data?: object) => withHeaders(request(server).delete(url)).send(data ?? {}),
        /** A multipart request, for uploads */
        upload: (url: string) => withHeaders(request(server).post(url)),
    }
}

/** A browser-like session that keeps its cookies between requests (for sign-in flows) */
export function agent(options: { ajax?: boolean } = {}) {
    if (!app) {
        throw new Error('Call useSolder() in the test file first')
    }
    const browser = request.agent(app.getHttpServer())
    const headers: Record<string, string> = { Accept: BROWSER_ACCEPT, ...(options.ajax ? { 'X-Requested-With': 'XMLHttpRequest' } : {}) }
    return {
        get: (url: string) => browser.get(url).set(headers),
        post: (url: string, data?: object) => browser.post(url).set(headers).type('form').send(formEncode(data ?? {})),
        delete: (url: string, data?: object) => browser.delete(url).set(headers).type('form').send(formEncode(data ?? {})),
        /** Whether the session is signed in */
        async isAuthenticated(): Promise<boolean> {
            const response = await browser.get('/dashboard')
            return response.status === 200
        },
    }
}

/** A form body with nested arrays as PHP and browsers send them: changes[0][old_modversion_id]=1 */
export function formEncode(data: object): string {
    const pairs: string[] = []
    const add = (key: string, value: unknown) => {
        if (value === null || value === undefined) {
            pairs.push(`${encodeURIComponent(key)}=`)
        } else if (Array.isArray(value)) {
            value.forEach((item, index) => add(`${key}[${index}]`, item))
        } else if (typeof value === 'object') {
            for (const [child, item] of Object.entries(value)) {
                add(`${key}[${child}]`, item)
            }
        } else {
            pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value === true ? 1 : value === false ? 0 : value))}`)
        }
    }
    for (const [key, value] of Object.entries(data)) {
        add(key, value)
    }
    return pairs.join('&')
}

export const actingAs =(user: Pick<User, 'id'>, options: Omit<ClientOptions, 'user'> = {}) => client({ ...options, user })

/** Data the response flashed to the session (assertSessionHas) */
export function flashed(response: { headers: Record<string, string | string[] | undefined> }): Record<string, unknown> {
    const header = response.headers['x-testing-flash']
    return header ? (JSON.parse(Buffer.from(String(header), 'base64').toString('utf8')) as Record<string, unknown>) : {}
}

/** Errors flashed by the response, by field (assertSessionHasErrors) */
export function flashedErrors(response: Parameters<typeof flashed>[0]): Record<string, string[]> {
    return (flashed(response).errors as Record<string, string[]> | undefined) ?? {}
}

/** Where a redirect goes, as a path */
export function redirectPath(response: { headers: Record<string, string | string[] | undefined> }): string {
    const location = String(response.headers.location ?? '')
    return location.replace(/^https?:\/\/[^/]+/, '')
}

/** The last view rendered and its data (assertViewIs / assertViewHas) */
export function lastView() {
    return testing.lastView
}

/** A throwaway mod repository (FakesModProviders::setUpModRepository) */
export function useModRepository(): { path: () => string } {
    let repository = ''
    beforeEach(() => {
        repository = `${mkdtempSync(join(tmpdir(), 'solder-test-repo-')).replaceAll('\\', '/')}/`
        config.solder.repo_location = repository
        Http.preventStrayRequests()
    })
    afterEach(() => rmSync(repository, { recursive: true, force: true }))
    return { path: () => repository }
}

/** Contents of a zip/jar holding the given files */
export function makeArchive(files: Record<string, string | Buffer>): Buffer {
    const zip = new ZipWriter()
    for (const [name, contents] of Object.entries(files)) {
        zip.addFromString(name, contents)
    }
    return zip.toBuffer()
}

/** A Fabric mod jar declaring the given version and Minecraft dependency */
export function makeFabricJar(id: string, version: string, minecraft = '1.20.1'): Buffer {
    return makeArchive({ 'fabric.mod.json': JSON.stringify({ id, version, depends: { minecraft: `~${minecraft}` } }) })
}

/** Place a mod version's zip in the repository, as Solder stores it */
export function putModversionZip(modName: string, version: string, files: Record<string, string | Buffer>): void {
    const directory = `${config.solder.repo_location}mods/${modName}`
    mkdirSync(directory, { recursive: true })
    writeFileSync(`${directory}/${modName}-${version}.zip`, makeArchive(files))
}

/** Fake Fabric Meta with a stable and an unstable loader for the given game versions */
export function fakeFabricMeta(gameVersions = ['1.18.2', '1.20.1', '26.1']): void {
    Http.fake({
        'meta.fabricmc.net/v2/versions/loader/*/profile/json': { body: { id: 'fabric-loader-profile' } },
        'meta.fabricmc.net/v2/versions/game': { body: gameVersions.map((version) => ({ version, stable: true })) },
        'meta.fabricmc.net/v2/versions/loader': {
            body: [
                { version: '0.15.0', stable: false },
                { version: '0.14.9', stable: true },
            ],
        },
    })
}

/** HTML-escape text the way Blade did, for assertSee() */
export function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** assertSee(): the escaped text appears in the response */
export function expectSee(response: { text: string }, text: string): void {
    expect(response.text).toContain(escapeHtml(text))
}

export function expectDontSee(response: { text: string }, text: string): void {
    expect(response.text).not.toContain(escapeHtml(text))
}

/** The JSON bodies of the recorded requests to a URL */
export function sentTo(url: string): Record<string, unknown>[] {
    return Http.recorded()
        .filter((request) => request.url === url)
        .map((request) => JSON.parse(request.body ?? '{}') as Record<string, unknown>)
}

/** Buffer a download's body (supertest only parses text and JSON) */
export function binary<T extends request.Test>(test: T): T {
    return test.buffer(true).parse((res, callback) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => callback(null, Buffer.concat(chunks)))
    })
}
