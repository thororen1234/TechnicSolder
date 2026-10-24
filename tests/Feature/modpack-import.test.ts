import { db } from '../../src/database/prisma.js'
import { route } from '../../src/http/urls.js'
import { SCHEDULE } from '../../src/jobs/schedule.js'
import { CANCELLED, COMPLETED, FAILED, WAITING, WAITING_DAYS, cancelAbandonedImports, importLog, importProblems } from '../../src/models/modpack-import.js'
import type { Build, Modpack, ModpackImport } from '../../src/models/types.js'
import { BACKUP_FORMAT } from '../../src/services/pack-export.js'
import { Http } from '../../src/support/http.js'
import { localExists } from '../../src/support/storage.js'
import {
    actingAs,
    admin,
    expectDontSee,
    expectSee,
    fakeFabricMeta,
    flashed,
    flashedErrors,
    makeArchive,
    makeUser,
    redirectPath,
    useModRepository,
    useSolder,
} from '../support/helpers.js'

describe('Importing into an existing modpack', () => {
    useSolder()
    useModRepository()
    let modpack: Modpack
    let existingBuild: Build

    beforeEach(async () => {
        modpack = await db.modpack.create({ data: { name: 'DeceasedCraft', slug: 'deceasedcraft' } })
        existingBuild = await db.build.create({ data: { modpack_id: modpack.id, version: '5.5.5', minecraft: '1.20.1', is_published: true } })
        const oldMod = await db.mod.create({ data: { name: 'old-mod', pretty_name: 'Old Mod' } })
        const modversion = await db.modversion.create({ data: { mod_id: oldMod.id, version: '1.0', md5: 'x' } })
        await db.buildModversion.create({ data: { build_id: existingBuild.id, modversion_id: modversion.id } })
    })
    afterEach(() => vi.useRealTimers())

    /** A Modrinth pack with no mods, only an override file, so importing it needs no network */
    const pack = (version: string, dependencies: Record<string, string> = { minecraft: '1.20.1' }) =>
        makeArchive({
            'modrinth.index.json': JSON.stringify({ formatVersion: 1, game: 'minecraft', versionId: version, name: 'DeceasedCraft', files: [], dependencies }),
            'overrides/config/pack.txt': `version ${version}`,
        })

    async function importInto(contents: Buffer | string, fields: Record<string, string> = {}, user?: { id: number }) {
        let test = actingAs(user ?? (await admin()))
            .upload('/modpack/import')
            .field('target', 'existing')
            .field('modpack_id', String(modpack.id))
            .field('source', 'file')
        for (const [name, value] of Object.entries(fields)) {
            test = test.field(name, value)
        }
        return test.attach('file', Buffer.from(contents), 'deceasedcraft.mrpack')
    }

    /** "mod version" for every mod in the build */
    async function buildMods(build: Build): Promise<string[]> {
        const links = await db.buildModversion.findMany({ where: { build_id: build.id } })
        const modversions = await db.modversion.findMany({ where: { id: { in: links.map((link) => link.modversion_id) } } })
        const mods = await db.mod.findMany({ where: { id: { in: modversions.map((mv) => mv.mod_id) } } })
        return modversions.map((mv) => `${mods.find((mod) => mod.id === mv.mod_id)!.name} ${mv.version}`).sort()
    }

    async function soleImport(): Promise<ModpackImport> {
        const imports = await db.modpackImport.findMany()
        expect(imports).toHaveLength(1)
        return imports[0]
    }

    const reload = (modpackImport: ModpackImport) => db.modpackImport.findUniqueOrThrow({ where: { id: modpackImport.id } })
    const reportPath = (modpackImport: ModpackImport | number) => new URL(route('modpack.import.show', typeof modpackImport === 'number' ? modpackImport : modpackImport.id)).pathname
    const decide = async (modpackImport: ModpackImport, data: object, user?: { id: number }) => actingAs(user ?? (await admin())).post(reportPath(modpackImport), data)
    const buildsOf = () => db.build.findMany({ where: { modpack_id: modpack.id } })
    const messages = (modpackImport: ModpackImport) => importLog(modpackImport).map((entry) => entry.message)

    it('makes a new version a build of the existing modpack', async () => {
        const modpackCount = await db.modpack.count()
        const response = await importInto(pack('5.5.4'))

        const build = await db.build.findFirstOrThrow({ where: { modpack_id: modpack.id, version: '5.5.4' } })
        expect(redirectPath(response)).toBe(`/modpack/build/${build.id}`)
        expect(flashed(response).success).toBe('0 mod(s) imported.')
        expect(Boolean(build.is_published)).toBe(false)
        expect(await buildMods(build)).toEqual(['deceasedcraft-overrides 5.5.4'])
        expect(await db.modpack.count()).toBe(modpackCount)

        const modpackImport = await soleImport()
        expect(modpackImport.status).toBe(COMPLETED)
        expect(modpackImport.build_id).toBe(build.id)
        expect(modpackImport.archive_path).toBeNull()
        expect(messages(modpackImport)).toContain('Adding build 5.5.4 to DeceasedCraft')
        expect((await db.activityLog.findFirstOrThrow({ where: { action: 'build.imported' } })).description).toBe('Imported build 5.5.4 from deceasedcraft.mrpack')
    })

    it('lets the build version be chosen', async () => {
        await importInto(pack('5.5.5'), { build_version: '5.5.5-hotfix' })
        expect(await db.build.count({ where: { modpack_id: modpack.id, version: '5.5.5-hotfix' } })).toBe(1)
        expect(await buildMods(existingBuild)).toEqual(['old-mod 1.0'])
    })

    it('waits for a decision on an existing build version without changing anything', async () => {
        const response = await importInto(pack('5.5.5'))
        const modpackImport = await soleImport()
        expect(redirectPath(response)).toBe(reportPath(modpackImport))
        expect(modpackImport.status).toBe(WAITING)
        expect(modpackImport.build_version).toBe('5.5.5')
        expect(localExists(String(modpackImport.archive_path))).toBe(true)
        expect(await buildMods(existingBuild)).toEqual(['old-mod 1.0'])
        expect(await buildsOf()).toHaveLength(1)

        const report = await actingAs(await admin()).get(reportPath(modpackImport)).expect(200)
        for (const text of ['DeceasedCraft already has a build 5.5.5.', 'Overwrite 5.5.5', 'Import as new build', 'Cancel import']) {
            expectSee(report, text)
        }
    })

    it('replaces the mods of the build when overwriting, and keeps the build', async () => {
        await importInto(pack('5.5.5'))
        const modpackImport = await soleImport()
        const archivePath = String(modpackImport.archive_path)

        const response = await decide(modpackImport, { action: 'overwrite' })
        expect(redirectPath(response)).toBe(`/modpack/build/${existingBuild.id}`)
        expect(await buildMods(existingBuild)).toEqual(['deceasedcraft-overrides 5.5.5'])
        expect(Boolean((await db.build.findUniqueOrThrow({ where: { id: existingBuild.id } })).is_published)).toBe(true)
        expect(await buildsOf()).toHaveLength(1)

        const finished = await reload(modpackImport)
        expect(finished.status).toBe(COMPLETED)
        expect(Boolean(finished.overwrite)).toBe(true)
        expect(importProblems(finished)).toEqual([])
        expect(localExists(archivePath)).toBe(false)
        expect(messages(finished)).toContain('admin chose to overwrite build 5.5.5.')
        expect((await db.activityLog.findFirstOrThrow({ where: { action: 'build.imported' } })).description).toBe('Overwrote build 5.5.5 from deceasedcraft.mrpack')
    })

    it('keeps a downloaded pack while waiting so it is not downloaded twice', async () => {
        Http.fake({ 'example.com/*': { body: pack('5.5.5') } })
        await actingAs(await admin()).post('/modpack/import', {
            target: 'existing',
            modpack_id: modpack.id,
            source: 'url',
            url: 'https://example.com/deceasedcraft-5.5.5.mrpack',
        })

        const modpackImport = await soleImport()
        expect(modpackImport.status).toBe(WAITING)
        expect(modpackImport.source).toBe('https://example.com/deceasedcraft-5.5.5.mrpack')
        expect(modpackImport.archive_path).toMatch(/\.mrpack$/)
        expect(localExists(String(modpackImport.archive_path))).toBe(true)

        await decide(modpackImport, { action: 'overwrite' })
        expect((await reload(modpackImport)).status).toBe(COMPLETED)
        expect(Http.recorded().filter((request) => request.url.includes('example.com'))).toHaveLength(1)
    })

    it('adds a build when importing under another version', async () => {
        await importInto(pack('5.5.5'))
        const modpackImport = await soleImport()

        expect(flashedErrors(await decide(modpackImport, { action: 'rename', version: '5.5.5' })).version).toEqual(['This modpack already has a build 5.5.5 too.'])
        expect((await reload(modpackImport)).status).toBe(WAITING)

        await decide(modpackImport, { action: 'rename', version: '5.5.6' })
        const build = await db.build.findFirstOrThrow({ where: { modpack_id: modpack.id, version: '5.5.6' } })
        expect(await buildMods(build)).toEqual(['deceasedcraft-overrides 5.5.6'])
        expect(await buildMods(existingBuild)).toEqual(['old-mod 1.0'])
        expect((await reload(modpackImport)).status).toBe(COMPLETED)
    })

    it('discards the archive when cancelled', async () => {
        await importInto(pack('5.5.5'))
        const modpackImport = await soleImport()
        const archivePath = String(modpackImport.archive_path)

        const response = await decide(modpackImport, { action: 'cancel' })
        expect(redirectPath(response)).toBe(reportPath(modpackImport))
        expect(flashed(response).success).toBe('Import cancelled. Nothing was changed.')
        expect((await reload(modpackImport)).status).toBe(CANCELLED)
        expect(localExists(archivePath)).toBe(false)
        expect(await buildMods(existingBuild)).toEqual(['old-mod 1.0'])

        expect(Object.keys(flashedErrors(await decide(modpackImport, { action: 'overwrite' }))).length).toBeGreaterThan(0)
    })

    it('cancels decisions abandoned for a week', async () => {
        await importInto(pack('5.5.5'))
        const modpackImport = await soleImport()
        const archivePath = String(modpackImport.archive_path)
        const day = 86400 * 1000

        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(Date.now() + (WAITING_DAYS - 1) * day)
        expect(await cancelAbandonedImports()).toBe(0)

        vi.setSystemTime(Date.now() + 2 * day)
        expect(await cancelAbandonedImports()).toBe(1)
        expect((await reload(modpackImport)).status).toBe(CANCELLED)
        expect(localExists(archivePath)).toBe(false)
        expect(SCHEDULE.map((task) => task.name)).toContain('cancel-abandoned-imports')
    })

    it('lists problems and the log in the report', async () => {
        fakeFabricMeta()
        await importInto(pack('5.6.0', { minecraft: '1.20.1', 'fabric-loader': '9.9.9' }))

        const modpackImport = await soleImport()
        const problems = importProblems(modpackImport)
        expect(problems).toEqual(['Could not find fabric 9.9.9 for Minecraft 1.20.1. Add the mod loader to the build manually.'])
        expect(importLog(modpackImport).find((entry) => entry.message === problems[0])?.level).toBe('error')

        const report = await actingAs(await admin()).get(reportPath(modpackImport)).expect(200)
        for (const text of ['1 problem', 'Could not find fabric 9.9.9 for Minecraft 1.20.1', 'Modrinth pack DeceasedCraft 5.6.0: 0 files for Minecraft 1.20.1, fabric 9.9.9', 'Only problems (1)']) {
            expectSee(report, text)
        }

        const view = await actingAs(await admin()).get(`/modpack/view/${modpack.id}`).expect(200)
        expectSee(view, 'Imports')
        expect(view.text).toContain(`${reportPath(modpackImport)}"`)
    })

    it('keeps a report of failed imports', async () => {
        const response = await importInto(makeArchive({ 'readme.txt': 'hi' }))
        expect(redirectPath(response)).toBe('/modpack/import')
        const modpackImport = await soleImport()
        expect(modpackImport.status).toBe(FAILED)
        expect(importProblems(modpackImport)[0]).toContain('Unrecognized modpack format')
        expect(modpackImport.archive_path).toBeNull()

        const list = await actingAs(await admin()).get('/modpack/import').expect(200)
        expectSee(list, 'Recent imports')
        expectSee(list, 'Failed')
        expectSee(await actingAs(await admin()).get(reportPath(modpackImport)).expect(200), 'Unrecognized modpack format')
    })

    it('cannot import a Solder backup into an existing modpack', async () => {
        await importInto(JSON.stringify({ format: BACKUP_FORMAT, modpack: { name: 'x' }, builds: [] }))
        expect(importProblems(await soleImport())[0]).toContain('can only be restored as a new modpack')
    })

    it('needs permission to manage the modpack', async () => {
        const other = await db.modpack.create({ data: { name: 'Other', slug: 'other' } })
        const developer = await makeUser({ modpacks_manage: true, modpacks: [other.id] })

        const page = await actingAs(developer).get('/modpack/import').expect(200)
        expectSee(page, 'Other')
        expectDontSee(page, 'DeceasedCraft')
        expect(redirectPath(await importInto(pack('5.5.4'), {}, developer))).toBe('/dashboard')
        expect(await db.modpackImport.count()).toBe(0)

        const response = await actingAs(developer).post('/modpack/import', { target: 'new', name: 'New', slug: 'new', source: 'url', url: 'https://example.com/pack.mrpack' })
        expect(redirectPath(response)).toBe('/dashboard')
    })

    it('shows reports only to the importer and managers of the modpack', async () => {
        await importInto(pack('5.5.5'))
        const modpackImport = await soleImport()
        const manager = await makeUser({ modpacks_manage: true })

        expect(redirectPath(await actingAs(manager).get(reportPath(modpackImport)))).toBe('/dashboard')
        expect(redirectPath(await decide(modpackImport, { action: 'cancel' }, manager))).toBe('/dashboard')
        expect((await reload(modpackImport)).status).toBe(WAITING)

        expect(redirectPath(await actingAs(manager).get(reportPath(999)))).toBe('/modpack/import')
    })
})
