import { config } from '../../src/config.js'
import { db } from '../../src/database/prisma.js'
import { route, appUrl } from '../../src/http/urls.js'
import { ExportBuild } from '../../src/jobs/build-jobs.js'
import { ImportModpack } from '../../src/jobs/import-modpack.js'
import { Queue } from '../../src/jobs/queue.js'
import { SCHEDULE } from '../../src/jobs/schedule.js'
import { checkUpdates, type Output } from '../../src/commands.js'
import { SUMMARY_CACHE_KEY } from '../../src/services/build-update.js'
import { DiscordNotifier } from '../../src/services/discord-notifier.js'
import { TaskTracker } from '../../src/services/task-tracker.js'
import { Cache } from '../../src/support/cache.js'
import { Http } from '../../src/support/http.js'
import { localExists } from '../../src/support/storage.js'
import type { Build, Modpack } from '../../src/models/types.js'
import {
    actingAs,
    admin,
    expectDontSee,
    expectSee,
    flashed,
    flashedErrors,
    makeArchive,
    makeUser,
    putModversionZip,
    redirectPath,
    sentTo,
    useModRepository,
    useSolder,
} from '../support/helpers.js'

function taskIdFrom(location: string | undefined): string {
    expect(location).toMatch(/\/task\/([0-9a-f-]{36})$/)
    return String(location).split('/').pop() as string
}

/** Collects what a command prints, like artisan's expectsOutput() */
function captureOutput(): Output & { lines: string[] } {
    const lines: string[] = []
    return {
        lines,
        info: (message) => lines.push(message),
        warn: (message) => lines.push(message),
        table: (rows) => lines.push(...rows.map((row) => Object.values(row).join(' | '))),
    }
}

describe('Background tasks', () => {
    useSolder()
    useModRepository()

    it('reports progress of a queued import and links to the modpack', async () => {
        Queue.fake()
        const pack = makeArchive({
            'modrinth.index.json': JSON.stringify({ formatVersion: 1, game: 'minecraft', versionId: '1.0', files: [], dependencies: { minecraft: '1.20.1' } }),
        })
        const response = await actingAs(await admin())
            .upload('/modpack/import')
            .field('name', 'Queued Pack')
            .field('slug', 'queued-pack')
            .field('source', 'file')
            .attach('file', pack, 'pack.mrpack')
        const taskId = taskIdFrom(response.headers.location)
        expectSee(await actingAs(await admin()).get(`/task/${taskId}`).expect(200), 'Importing Queued Pack')
        expect((await actingAs(await admin(), { ajax: true }).get(`/task/${taskId}/status`)).body).toMatchObject({ status: 'queued' })

        const jobs = Queue.pushed(ImportModpack)
        expect(jobs).toHaveLength(1)
        const archivePath = String((await db.modpackImport.findUniqueOrThrow({ where: { id: jobs[0].importId } })).archive_path)
        expect(localExists(archivePath)).toBe(true)
        await ImportModpack.handle(jobs[0])

        const modpack = await db.modpack.findFirstOrThrow({ where: { slug: 'queued-pack' } })
        const modpackImport = await db.modpackImport.findUniqueOrThrow({ where: { id: jobs[0].importId } })
        expect((await actingAs(await admin(), { ajax: true }).get(`/task/${taskId}/status`)).body).toMatchObject({
            status: 'completed',
            url: appUrl(`modpack/view/${modpack.id}`),
            download: false,
            report_url: route('modpack.import.show', modpackImport.id),
        })
        expect(localExists(archivePath)).toBe(false)
        expect(modpackImport.archive_path).toBeNull()
    })

    it('lets only its owner download a queued export', async () => {
        Queue.fake()
        const modpack = await db.modpack.create({ data: { name: 'Export Pack', slug: 'export-pack' } })
        const build = await db.build.create({ data: { modpack_id: modpack.id, version: '1.0.0', minecraft: '1.20.1' } })
        const mod = await db.mod.create({ data: { name: 'example', pretty_name: 'Example' } })
        putModversionZip('example', '1.0', { 'mods/example.jar': 'jar' })
        const modversion = await db.modversion.create({ data: { mod_id: mod.id, version: '1.0', md5: 'x' } })
        await db.buildModversion.create({ data: { build_id: build.id, modversion_id: modversion.id } })

        const response = await actingAs(await admin()).get(`/modpack/build/${build.id}/export/technic`)
        const taskId = taskIdFrom(response.headers.location)
        await ExportBuild.handle(Queue.pushed(ExportBuild)[0])

        expect((await actingAs(await admin(), { ajax: true }).get(`/task/${taskId}/status`)).body).toMatchObject({ status: 'completed', download: true })
        const download = await actingAs(await admin()).get(`/task/${taskId}/download`).expect(200)
        expect(download.headers['content-disposition']).toMatch(/^attachment; filename="?export-pack-1.0.0.zip"?$/)

        const other = await makeUser({ solder_full: true })
        await actingAs(other).get(`/task/${taskId}`).expect(404)
        await actingAs(other).get(`/task/${taskId}/download`).expect(404)
    })

    it('reports a failed job on its task', async () => {
        const taskId = await TaskTracker.create(1, 'Exporting')
        await ExportBuild.failed!({ taskId, buildId: 1, format: 'technic' }, new Error('Disk full'))
        expect((await actingAs(await admin(), { ajax: true }).get(`/task/${taskId}/status`)).body).toMatchObject({
            status: 'failed',
            errors: ['The export stopped unexpectedly: Disk full'],
        })
    })

    it('does not find an unknown task', async () => {
        await actingAs(await admin()).get('/task/00000000-0000-0000-0000-000000000000').expect(404)
    })
})

describe('Notifications', () => {
    useSolder()
    useModRepository()
    const WEBHOOK = 'https://discord.test/api/webhooks/1/abc'
    let modpack: Modpack
    let build: Build

    beforeEach(async () => {
        config.solder.discord_webhook = WEBHOOK
        modpack = await db.modpack.create({ data: { name: 'Watched Pack', slug: 'watched-pack', latest: '1.0' } })
        build = await db.build.create({ data: { modpack_id: modpack.id, version: '1.0', minecraft: '1.20.1' } })
        const mod = await db.mod.create({ data: { name: 'sodium', pretty_name: 'Sodium' } })
        const modversion = await db.modversion.create({
            data: { mod_id: mod.id, version: '0.5.0', md5: 'x', provider: 'modrinth', provider_project_id: 'AANobbMI', provider_version_id: 'v1' },
        })
        await db.buildModversion.create({ data: { build_id: build.id, modversion_id: modversion.id } })
    })

    function fakeSodium(versions: string[]): void {
        Http.fake({
            'discord.test/*': { status: 204 },
            'api.modrinth.com/v2/project/AANobbMI': { body: { id: 'AANobbMI', slug: 'sodium', title: 'Sodium' } },
            'api.modrinth.com/v2/project/AANobbMI/members': { body: [] },
            'api.modrinth.com/v2/project/AANobbMI/version*': {
                body: versions.map((id) => ({
                    id,
                    version_number: id,
                    version_type: 'release',
                    game_versions: ['1.20.1'],
                    loaders: ['fabric'],
                    files: [{ url: `https://cdn.modrinth.com/${id}.jar`, filename: 'sodium.jar', primary: true }],
                })),
            },
        })
    }

    const discordMessages = () => sentTo(WEBHOOK).map((body) => (body.embeds as { title: string }[])[0].title)

    it('posts outdated modpacks after the update check and feeds the dashboard', async () => {
        fakeSodium(['v2', 'v1'])
        await checkUpdates(captureOutput())
        expect(discordMessages()).toEqual(['Mod updates available for 1 modpack'])
        const summary = await Cache.get<{ builds: unknown[] }>(SUMMARY_CACHE_KEY)
        expect(summary?.builds).toEqual([{ modpack_id: modpack.id, modpack: 'Watched Pack', build_id: build.id, build: '1.0', count: 1, mods: ['Sodium'] }])
        const dashboard = await actingAs(await admin()).get('/dashboard').expect(200)
        expectSee(dashboard, '1 modpack has mod updates')
        expectSee(dashboard, 'Watched Pack')
    })

    it('sends nothing when every modpack is up to date', async () => {
        fakeSodium(['v1'])
        const output = captureOutput()
        await checkUpdates(output)
        expect(output.lines).toContain('Every modpack is up to date.')
        expect(discordMessages()).toEqual([])
        expectSee(await actingAs(await admin()).get('/dashboard'), 'Every modpack is up to date')
    })

    it('posts nothing without a webhook', async () => {
        config.solder.discord_webhook = ''
        fakeSodium(['v2', 'v1'])
        await checkUpdates(captureOutput())
        expect(Http.recorded().filter((request) => request.url.includes('discord'))).toEqual([])
    })

    it('only lists modpacks the user manages on the dashboard', async () => {
        await Cache.forever(SUMMARY_CACHE_KEY, {
            checked_at: new Date().toISOString(),
            builds: [
                { modpack_id: modpack.id, modpack: 'Watched Pack', build_id: build.id, build: '1.0', count: 1, mods: ['Sodium'] },
                { modpack_id: 999, modpack: 'Secret Pack', build_id: 999, build: '1.0', count: 2, mods: ['Iris'] },
            ],
        })
        const developer = await makeUser({ modpacks: [modpack.id] })
        const dashboard = await actingAs(developer).get('/dashboard').expect(200)
        expectSee(dashboard, 'Watched Pack')
        expectDontSee(dashboard, 'Secret Pack')
    })

    it('runs the check straight away from the dashboard', async () => {
        fakeSodium(['v2', 'v1'])
        const response = await actingAs(await admin()).post('/dashboard/check-updates')
        expect(redirectPath(response)).toBe('/dashboard')
        expect(flashed(response).success).toBe('1 modpack has updates available.')
    })

    it('announces a published build', async () => {
        Http.fake({ 'discord.test/*': { status: 204 } })
        await actingAs(await admin(), { ajax: true }).post('/modpack/modify/published', { build: build.id, published: 1, force: 1 }).expect(200)
        expect(discordMessages()).toEqual(['Watched Pack 1.0 published'])
    })

    it('sends a test message', async () => {
        Http.fake({ 'discord.test/*': { status: 204 } })
        const response = await actingAs(await admin()).post('/solder/notifications/test')
        expect(redirectPath(response)).toBe('/solder/configure')
        expect(flashed(response).success).toBe('Test message sent to Discord.')
        expect(discordMessages()).toEqual(['Test message from Technic Solder'])

        config.solder.discord_webhook = ''
        expect(Object.keys(flashedErrors(await actingAs(await admin()).post('/solder/notifications/test'))).length).toBeGreaterThan(0)
    })

    it('direct messages each user with a bot and reuses the channel', async () => {
        Object.assign(config.solder, { discord_webhook: '', discord_bot_token: 'bot-token', discord_user_id: '111, 222' })
        Http.fake({
            'discord.com/api/v10/users/@me/channels': (request) => ({ body: { id: `dm-${(JSON.parse(String(request.body)) as { recipient_id: string }).recipient_id}` } }),
            'discord.com/api/v10/channels/*/messages': { body: { id: 'message' } },
        })
        expect(await DiscordNotifier.send('First', 'Hello')).toBe(true)
        expect(await DiscordNotifier.send('Second', 'Again')).toBe(true)

        const sent = Http.recorded().filter((request) => request.url.includes('discord.com'))
        expect(sent.map((request) => request.url.split('api/v10/')[1])).toEqual([
            'users/@me/channels',
            'channels/dm-111/messages',
            'users/@me/channels',
            'channels/dm-222/messages',
            'channels/dm-111/messages',
            'channels/dm-222/messages',
        ])
        expect(sent.every((request) => request.headers.Authorization === 'Bot bot-token')).toBe(true)
        expect((JSON.parse(String(sent.at(-1)?.body)) as { embeds: { title: string }[] }).embeds[0].title).toBe('Second')
    })

    it('reports a failed direct message and reopens the channel next time', async () => {
        Object.assign(config.solder, { discord_webhook: WEBHOOK, discord_bot_token: 'bot-token', discord_user_id: '111' })
        await Cache.forever('solder-discord-dm-channel:111', 'stale')
        Http.fake({
            'discord.test/*': { status: 204 },
            'discord.com/api/v10/channels/stale/messages': { status: 404, body: { message: 'Unknown Channel' } },
        })
        expect(await DiscordNotifier.send('Title', 'Body')).toBe(false)
        expect(discordMessages()).toEqual(['Title'])
        expect(await Cache.get('solder-discord-dm-channel:111')).toBeNull()
    })

    it('sends a test message with direct messages only', async () => {
        Object.assign(config.solder, { discord_webhook: '', discord_bot_token: 'bot-token', discord_user_id: '111' })
        Http.fake({
            'discord.com/api/v10/users/@me/channels': { body: { id: 'dm-111' } },
            'discord.com/api/v10/channels/*/messages': { body: { id: 'message' } },
        })
        expect(flashed(await actingAs(await admin()).post('/solder/notifications/test')).success).toBe('Test message sent to Discord.')
        expectSee(await actingAs(await admin()).get('/solder/configure'), 'Discord direct messages configured')

        config.solder.discord_user_id = ''
        expect(Object.keys(flashedErrors(await actingAs(await admin()).post('/solder/notifications/test'))).length).toBeGreaterThan(0)
    })

    it('schedules the nightly check', () => {
        expect(SCHEDULE.map((task) => task.name)).toContain('solder:check-updates')
    })
})
