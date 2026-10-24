import { existsSync } from 'node:fs'
import { db } from '../../src/database/prisma.js'
import { activityProperties, recordActivity } from '../../src/models/activity-log.js'
import { repositoryPath } from '../../src/models/modversion.js'
import { unusedModversionIds } from '../../src/models/relations.js'
import type { Build, Mod, Modpack, Modversion } from '../../src/models/types.js'
import { runWithContext } from '../../src/http/context.js'
import {
    actingAs,
    admin,
    bearerToken,
    client,
    escapeHtml,
    expectDontSee,
    expectSee,
    flashed,
    flashedErrors,
    lastView,
    makeUser,
    putModversionZip,
    redirectPath,
    useModRepository,
    useSolder,
} from '../support/helpers.js'

function expectSeeInOrder(response: { text: string }, texts: string[]): void {
    let position = 0
    for (const text of texts) {
        const found = response.text.indexOf(escapeHtml(text), position)
        expect(found, `"${text}" after position ${position}`).toBeGreaterThanOrEqual(0)
        position = found + text.length
    }
}

describe('Activity log', () => {
    useSolder()
    let modpack: Modpack
    let build: Build
    beforeEach(async () => {
        modpack = await db.modpack.create({ data: { name: 'Logged Pack', slug: 'logged-pack' } })
        build = await db.build.create({ data: { modpack_id: modpack.id, version: '1.0', minecraft: '1.20.1' } })
        const mod = await db.mod.create({ data: { name: 'sodium', pretty_name: 'Sodium' } })
        await db.modversion.createMany({ data: [{ mod_id: mod.id, version: '0.5.0', md5: 'x' }, { mod_id: mod.id, version: '0.5.1', md5: 'x' }] })
    })
    const descriptions = async () => (await db.activityLog.findMany({ orderBy: { id: 'asc' } })).map((entry) => entry.description)
    const modify = async (action: string, data: object) => {
        await actingAs(await admin(), { ajax: true }).post(`/modpack/modify/${action}`, data).expect(200)
    }

    it('records build edits with the user', async () => {
        const old = (await db.modversion.findFirstOrThrow({ where: { version: '0.5.0' } })).id
        const updated = (await db.modversion.findFirstOrThrow({ where: { version: '0.5.1' } })).id
        await modify('add', { build: build.id, 'mod-name': 'sodium', 'mod-version': '0.5.0' })
        await modify('version', { build_id: build.id, modversion_id: old, version: updated })
        await modify('published', { build: build.id, published: 1, force: 1 })
        await modify('delete', { build_id: build.id, modversion_id: updated })
        expect(await descriptions()).toEqual([
            'Added Sodium 0.5.0 to build 1.0',
            'Changed Sodium from 0.5.0 to 0.5.1 in build 1.0',
            'Published build 1.0',
            'Removed Sodium 0.5.1 from build 1.0',
        ])
        const entry = await db.activityLog.findFirstOrThrow({ orderBy: { id: 'asc' } })
        expect(entry).toMatchObject({ user_id: 1, modpack_id: modpack.id, build_id: build.id })
        expect(activityProperties(entry)).toEqual({ mod: 'sodium', version: '0.5.0' })
    })

    it('records API changes with the token user', async () => {
        const token = await bearerToken(await admin())
        await client({ token }).postJson('/api/modpack/logged-pack/1.0/mod', { mod_slug: 'sodium', mod_version: '0.5.0' }).expect(201)
        expect(await descriptions()).toEqual(['Added Sodium 0.5.0 to build 1.0 (API)'])
        expect((await db.activityLog.findFirstOrThrow()).user_id).toBe(1)
    })

    it('shows activity on the modpack and build pages', async () => {
        await recordActivity('build.mod_added', 'Added Sodium 0.5.0 to build 1.0', { build })
        expectSee(await actingAs(await admin()).get(`/modpack/view/${modpack.id}`).expect(200), 'Added Sodium 0.5.0 to build 1.0')
        expectSee(await actingAs(await admin()).get(`/modpack/build/${build.id}`).expect(200), 'Added Sodium 0.5.0 to build 1.0')
    })

    it('only shows modpacks the user manages on the activity page', async () => {
        const other = await db.modpack.create({ data: { name: 'Secret Pack', slug: 'secret-pack' } })
        await runWithContext({ userId: 1 }, async () => {
            await recordActivity('modpack.edited', 'Edited the details of Logged Pack', { modpack })
            await recordActivity('modpack.edited', 'Edited the details of Secret Pack', { modpack: other })
        })
        const all = await actingAs(await admin()).get('/solder/activity').expect(200)
        expectSee(all, 'Logged Pack')
        expectSee(all, 'Secret Pack')
        const developer = await makeUser({ modpacks: [modpack.id] })
        const scoped = await actingAs(developer).get('/solder/activity').expect(200)
        expectSee(scoped, 'Edited the details of Logged Pack')
        expectDontSee(scoped, 'Edited the details of Secret Pack')
    })
})

describe('Comparing builds', () => {
    useSolder()
    let modpack: Modpack
    beforeEach(async () => {
        modpack = await db.modpack.create({ data: { name: 'Compare Pack', slug: 'compare-pack' } })
    })

    async function build(version: string, mods: Record<string, string>): Promise<Build> {
        const created = await db.build.create({ data: { modpack_id: modpack.id, version, minecraft: '1.20.1' } })
        for (const [name, modVersion] of Object.entries(mods)) {
            const mod = (await db.mod.findUnique({ where: { name } })) ?? (await db.mod.create({ data: { name, pretty_name: name[0].toUpperCase() + name.slice(1) } }))
            const modversion =
                (await db.modversion.findFirst({ where: { mod_id: mod.id, version: modVersion } })) ??
                (await db.modversion.create({ data: { mod_id: mod.id, version: modVersion, md5: 'x' } }))
            await db.buildModversion.create({ data: { build_id: created.id, modversion_id: modversion.id } })
        }
        return created
    }

    it('compares with the previous build by default', async () => {
        await build('1.0', { sodium: '0.5.0', iris: '1.6', optifine: 'HD_U' })
        const middle = await build('1.1', { sodium: '0.5.1', iris: '1.6', lithium: '0.11' })
        await build('1.2', { sodium: '0.5.2' })
        const response = await actingAs(await admin()).get(`/modpack/build/${middle.id}/compare`).expect(200)
        expectSeeInOrder(response, ['Added', 'Lithium', 'Updated', 'Sodium', '0.5.0', '0.5.1', 'Removed', 'Optifine'])
        expect(lastView()?.data.markdown).toBe(
            '## Compare Pack 1.1\n\nChanges since 1.0:\n\n### Added\n- Lithium 0.11\n\n### Updated\n- Sodium 0.5.0 → 0.5.1\n\n### Removed\n- Optifine',
        )
        expect(lastView()?.data.unchanged).toBe(1)
    })

    it('compares with a chosen build', async () => {
        const first = await build('1.0', { sodium: '0.5.0' })
        await build('1.1', { sodium: '0.5.1' })
        const latest = await build('1.2', { sodium: '0.5.2' })
        await actingAs(await admin()).get(`/modpack/build/${latest.id}/compare?with=${first.id}`).expect(200)
        expect((lastView()?.data.base as Build).version).toBe('1.0')
        expect(lastView()?.data.markdown).toContain('- Sodium 0.5.0 → 0.5.2')
    })

    it('has nothing to compare for the only build', async () => {
        const only = await build('1.0', { sodium: '0.5.0' })
        expectSee(await actingAs(await admin()).get(`/modpack/build/${only.id}/compare`).expect(200), 'nothing to compare')
    })

    it('needs access to the modpack', async () => {
        const only = await build('1.0', { sodium: '0.5.0' })
        expect(redirectPath(await actingAs(await makeUser()).get(`/modpack/build/${only.id}/compare`))).toBe('/dashboard')
    })
})

describe('Cleaning up unused mod versions', () => {
    useSolder()
    const repository = useModRepository()
    let used: Modversion
    let oldVersion: Modversion
    let orphan: Modversion

    async function version(mod: Mod, name: string): Promise<Modversion> {
        putModversionZip(mod.name, name, { [`mods/${mod.name}.jar`]: 'x'.repeat(2048) })
        return db.modversion.create({ data: { mod_id: mod.id, version: name, md5: 'x', filesize: 2048 } })
    }

    beforeEach(async () => {
        // The seeded mod versions aren't in any build either; start from a clean slate
        await db.modversion.deleteMany({ where: { id: { in: await unusedModversionIds() } } })
        const sodium = await db.mod.create({ data: { name: 'sodium', pretty_name: 'Sodium' } })
        const orphanMod = await db.mod.create({ data: { name: 'orphan', pretty_name: 'Orphan' } })
        used = await version(sodium, '0.5.1')
        oldVersion = await version(sodium, '0.5.0')
        orphan = await version(orphanMod, '1.0')
        const pack = await db.modpack.create({ data: { name: 'Pack', slug: 'pack' } })
        const pinned = await db.build.create({ data: { modpack_id: pack.id, version: '1.0', minecraft: '1.20.1' } })
        await db.buildModversion.create({ data: { build_id: pinned.id, modversion_id: used.id } })
    })

    const remaining = async () => (await db.modversion.findMany({ where: { id: { in: [used.id, oldVersion.id, orphan.id] } }, orderBy: { id: 'asc' } })).map((mv) => mv.id)
    const zip = (modversion: Modversion, modName: string) => repository.path() + repositoryPath({ name: modName }, modversion.version)

    it('lists only versions no build uses', async () => {
        await actingAs(await admin()).get('/mod/unused').expect(200)
        expect((lastView()?.data.modversions as Modversion[]).map((mv) => mv.id).sort()).toEqual([oldVersion.id, orphan.id].sort())
    })

    it('deletes the selected versions and their files, never one in use', async () => {
        const response = await actingAs(await admin()).post('/mod/unused', { modversions: [orphan.id, used.id], delete_files: 1 })
        expect(redirectPath(response)).toBe('/mod/unused')
        expect(String(flashed(response).success)).toMatch(/^Deleted 1 unused mod version and freed/)
        expect(await db.modversion.count({ where: { id: orphan.id } })).toBe(0)
        expect(existsSync(zip(orphan, 'orphan'))).toBe(false)
        expect(existsSync(`${repository.path()}mods/orphan`)).toBe(false)
        expect(await db.modversion.count({ where: { id: used.id } })).toBe(1)
        expect(existsSync(zip(used, 'sodium'))).toBe(true)
        expect(await db.modversion.count({ where: { id: oldVersion.id } })).toBe(1)
    })

    it('can delete them all and keep the files', async () => {
        const response = await actingAs(await admin()).post('/mod/unused', { all: 1 })
        expect(flashed(response).success).toBe('Deleted 2 unused mod versions. Their files were kept in the repository.')
        expect(await remaining()).toEqual([used.id])
        expect(existsSync(zip(oldVersion, 'sodium'))).toBe(true)
    })

    it('needs something selected', async () => {
        expect(Object.keys(flashedErrors(await actingAs(await admin()).post('/mod/unused', {}))).length).toBeGreaterThan(0)
        expect(await remaining()).toHaveLength(3)
    })

    it('needs permission to delete mods', async () => {
        const viewer = await makeUser()
        expect(redirectPath(await actingAs(viewer).get('/mod/unused'))).toBe('/dashboard')
        expect(redirectPath(await actingAs(viewer).post('/mod/unused', { all: 1 }))).toBe('/dashboard')
        expect(await remaining()).toHaveLength(3)
    })
})
