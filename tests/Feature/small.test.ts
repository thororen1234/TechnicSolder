import { checkUpdates, setup, type Output } from '../../src/commands.js'
import { config } from '../../src/config.js'
import { connectDatabase, db } from '../../src/database/prisma.js'
import { buildDownloadsDaily, buildDownloadTotals } from '../../src/models/build-download.js'
import { permissionFor } from '../../src/models/relations.js'
import { toDateString } from '../../src/support/dates.js'
import { actingAs, admin, client, expectSee, resetDatabase, seedTestData, useSolder } from '../support/helpers.js'

function capture(): Output & { lines: string[] } {
    const lines: string[] = []
    return { lines, info: (line) => lines.push(line), warn: (line) => lines.push(line), table: (rows) => lines.push(JSON.stringify(rows)) }
}

describe('CORS', () => {
    useSolder()

    it('allows every origin with a wildcard', async () => {
        config.solder.cors_allowed_origins = '*'
        const response = await client().get('/api/').set('Origin', 'https://evil.com')
        expect(response.headers['access-control-allow-origin']).toBe('*')
        expect(response.headers.vary).toBeUndefined()
    })

    it('reflects allowed origins only', async () => {
        config.solder.cors_allowed_origins = 'https://a.com, https://b.com'
        for (const origin of ['https://a.com', 'https://b.com']) {
            const response = await client().get('/api/').set('Origin', origin)
            expect(response.headers['access-control-allow-origin']).toBe(origin)
            expect(response.headers.vary).toBe('Origin')
        }
        const denied = await client().get('/api/').set('Origin', 'https://c.com')
        expect(denied.headers['access-control-allow-origin']).toBeUndefined()
        expect(denied.headers.vary).toBe('Origin')
    })

    it('reflects a single allowed origin and denies others', async () => {
        config.solder.cors_allowed_origins = 'https://example.com'
        const allowed = await client().get('/api/').set('Origin', 'https://example.com')
        expect(allowed.headers['access-control-allow-origin']).toBe('https://example.com')
        expect(allowed.headers.vary).toBe('Origin')
        const denied = await client().get('/api/').set('Origin', 'https://evil.com')
        expect(denied.headers['access-control-allow-origin']).toBeUndefined()
    })

    it('skips the header without an Origin when not a wildcard', async () => {
        config.solder.cors_allowed_origins = 'https://example.com'
        const response = await client().get('/api/')
        expect(response.headers['access-control-allow-origin']).toBeUndefined()
        expect(response.headers.vary).toBe('Origin')
    })
})

describe('Error responses', () => {
    useSolder()

    it('answers unknown API routes with JSON, even when HTML is asked for', async () => {
        const response = await client().get('/api/nonexistent-route').set('Accept', 'text/html').expect(404)
        expect(response.headers['content-type']).toMatch(/^application\/json/)
    })

    it('answers an unsupported API method with a JSON 405', async () => {
        const response = await client().delete('/api/').set('Accept', 'text/html').expect(405)
        expect(response.headers['content-type']).toMatch(/^application\/json/)
    })

    it('answers unknown web routes with an HTML page', async () => {
        const response = await client().get('/nonexistent-route').set('Accept', 'text/html').expect(404)
        expect(response.headers['content-type']).toBe('text/html; charset=utf-8')
    })
})

describe('Dashboard', () => {
    useSolder()

    it('shows unused mod versions', async () => {
        const mod = await db.mod.create({ data: { pretty_name: 'UnusedMod', name: 'unusedmod' } })
        await db.modversion.create({ data: { mod_id: mod.id, version: '2.0', md5: 'abc123def456abc123def456abc123de', filesize: 1024 } })
        const response = await actingAs(await admin()).get('/dashboard').expect(200)
        expectSee(response, 'Unused mod versions')
        expectSee(response, 'UnusedMod')
    })

    it('says when every mod version is used', async () => {
        const response = await actingAs(await admin()).get('/dashboard').expect(200)
        expectSee(response, 'Unused mod versions')
        expectSee(response, 'Every mod version is used by at least one build.')
    })
})

describe('solder setup', () => {
    useSolder({ seed: false })

    it('creates the admin user non-interactively with a generated password', async () => {
        const output = capture()
        expect(await setup({ interactive: false }, output)).toBe(0)
        expect(output.lines[0]).toBe("Admin user 'admin' created successfully.")
        expect(output.lines.some((line) => line.startsWith('Generated password:'))).toBe(true)
        expect(output.lines).toContain('Change this password immediately after first login.')
        const user = await db.user.findFirstOrThrow({ where: { username: 'admin' } })
        expect(user.email).toBe('admin@example.com')
        expect((await permissionFor(user.id))!.solder_full).toBe(true)
    })

    it('uses the configured password and email', async () => {
        config.solder.initial_admin_password = 'secretpass123'
        config.solder.initial_admin_email = 'custom@example.com'
        const output = capture()
        expect(await setup({ interactive: false }, output)).toBe(0)
        expect(output.lines.some((line) => line.includes('Generated password:'))).toBe(false)
        expect((await db.user.findFirstOrThrow()).email).toBe('custom@example.com')
    })

    it('accepts a custom username', async () => {
        const output = capture()
        expect(await setup({ username: 'superadmin', interactive: false }, output)).toBe(0)
        expect(output.lines[0]).toBe("Admin user 'superadmin' created successfully.")
        expect((await db.user.findFirstOrThrow()).username).toBe('superadmin')
    })

    it('does nothing when users exist', async () => {
        await resetDatabase()
        await seedTestData()
        const output = capture()
        expect(await setup({ interactive: false }, output)).toBe(0)
        expect(output.lines).toEqual(['An admin user already exists. Skipping setup.'])
    })

    it('reports that everything is up to date', async () => {
        const output = capture()
        expect(await checkUpdates(output)).toBe(0)
        expect(output.lines).toEqual(['Every modpack is up to date.'])
    })
})

describe('Build downloads', () => {
    useSolder()
    let buildId = 0
    let modpackId = 0
    beforeEach(async () => {
        const modpack = await db.modpack.create({ data: { name: 'Popular Pack', slug: 'popular-pack' } })
        modpackId = modpack.id
        buildId = (await db.build.create({ data: { modpack_id: modpack.id, version: '1.0', minecraft: '1.20.1', is_published: true } })).id
    })
    afterEach(() => {
        vi.useRealTimers()
    })
    const launch = () => client().get('/api/modpack/popular-pack/1.0')
    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000)

    it('counts launcher requests per day', async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(new Date('2026-10-20T12:00:00Z'))
        await launch().expect(200)
        await launch().expect(200)
        expect(await buildDownloadTotals([buildId])).toEqual({ [buildId]: 2 })
        vi.setSystemTime(new Date('2026-10-21T12:00:00Z'))
        await launch().expect(200)
        expect(await buildDownloadTotals([buildId])).toEqual({ [buildId]: 3 })
        const daily = Object.values(await buildDownloadsDaily(buildId))
        expect(daily).toHaveLength(30)
        expect(daily.slice(-2)).toEqual([2, 1])
    })

    it('puts days returned as dates (MySQL, PostgreSQL) on the right day outside UTC', async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(new Date('2026-10-21T12:00:00Z'))
        config.app.timezone = 'EST'
        // What the MariaDB adapter returns for a DATE column: midnight UTC
        const query = vi.spyOn(await connectDatabase(), '$queryRawUnsafe').mockResolvedValue([
            { build_id: buildId, date: new Date('2026-10-20T00:00:00Z'), count: 4 },
            { build_id: buildId, date: new Date('2026-10-21T00:00:00Z'), count: 7 },
        ])
        try {
            const daily = await buildDownloadsDaily(buildId)
            expect(daily['2026-10-20']).toBe(4)
            expect(daily['2026-10-21']).toBe(7)
        } finally {
            query.mockRestore()
        }
    })

    it('does not count requests for unpublished builds', async () => {
        await db.build.update({ where: { id: buildId }, data: { is_published: false } })
        await launch().expect(404)
        expect(await db.buildDownload.count()).toBe(0)
    })

    it('drops old requests out of the totals', async () => {
        await db.$executeRawUnsafe('INSERT INTO build_downloads (build_id, date, count) VALUES (?, ?, 99), (?, ?, 5)', buildId, toDateString(daysAgo(40)), buildId, toDateString(daysAgo(3)))
        expect(await buildDownloadTotals([buildId])).toEqual({ [buildId]: 5 })
    })

    it('shows launches on the modpack and build pages', async () => {
        await db.$executeRawUnsafe('INSERT INTO build_downloads (build_id, date, count) VALUES (?, ?, 1234)', buildId, toDateString(new Date()))
        const modpackPage = await actingAs(await admin()).get(`/modpack/view/${modpackId}`).expect(200)
        expectSee(modpackPage, 'Launches (30 days)')
        expectSee(modpackPage, '1,234')
        const buildPage = await actingAs(await admin()).get(`/modpack/build/${buildId}`).expect(200)
        expect(buildPage.text).toContain('1,234</span> in the last 30 days')
    })
})
