import { createHash } from 'node:crypto'
import { config } from '../../src/config.js'
import { db } from '../../src/database/prisma.js'
import { CurseForge } from '../../src/mods/providers/curseforge.js'
import { Modrinth } from '../../src/mods/providers/modrinth.js'
import type { Build } from '../../src/models/types.js'
import { Http } from '../../src/support/http.js'
import { ZipReader } from '../../src/support/zip.js'
import { actingAs, admin, binary, makeArchive, makeFabricJar, putModversionZip, useModRepository, useSolder } from '../support/helpers.js'

const sha1 = (text: string) => createHash('sha1').update(text).digest('hex')

describe('Mod environments', () => {
    useSolder()
    useModRepository()

    const environmentOf = async (id: number | undefined) => (await db.modversion.findUniqueOrThrow({ where: { id } })).environment

    it('makes Modrinth projects that do not run on servers client only', async () => {
        Http.fake({
            'api.modrinth.com/v2/project/xaero': { body: { id: 'xaero', slug: 'xaeros-minimap', title: "Xaero's Minimap", client_side: 'required', server_side: 'unsupported' } },
            'api.modrinth.com/v2/project/xaero/members': { body: [] },
            'api.modrinth.com/v2/project/xaero/version': {
                body: [
                    {
                        id: 'v1',
                        version_number: '24.0',
                        game_versions: ['1.20.1'],
                        loaders: ['fabric'],
                        files: [{ url: 'https://cdn.modrinth.com/data/xaero/versions/v1/minimap.jar', filename: 'minimap.jar', primary: true }],
                    },
                ],
            },
            'cdn.modrinth.com/*': { body: makeFabricJar('xaerominimap', '24.0') },
        })
        const result = await Modrinth.install('xaero', ['v1'])
        expect(await environmentOf(result.modversionIds.get('v1'))).toBe('client')
    })

    it('reads CurseForge files tagged for one side', async () => {
        config.solder.curseforge_api_key = 'test-key'
        Http.fake({
            'api.curseforge.com/v1/mods/1': { body: { data: { id: 1, slug: 'mod', name: 'Mod', classId: 6 } } },
            'api.curseforge.com/v1/mods/1/files*': {
                body: {
                    data: [
                        { id: 10, modId: 1, fileName: 'a.jar', gameVersions: ['1.20.1', 'Forge', 'Server'] },
                        { id: 11, modId: 1, fileName: 'b.jar', gameVersions: ['1.20.1', 'Forge', 'Client', 'Server'] },
                    ],
                },
            },
        })
        const versions = (await CurseForge.mod('1'))!.versions
        expect(versions.get('10')?.environment).toBe('server')
        expect(versions.get('11')?.environment).toBeNull()
    })

    it('uses the side an uploaded jar declares', async () => {
        const jar = makeArchive({ 'fabric.mod.json': JSON.stringify({ id: 'zoom', version: '1.0', environment: 'client' }) })
        await actingAs(await admin()).upload('/mod/upload').attach('files[]', jar, 'zoom.jar')
        const zoom = await db.mod.findUniqueOrThrow({ where: { name: 'zoom' } })
        expect((await db.modversion.findMany({ where: { mod_id: zoom.id } })).map((mv) => mv.environment)).toEqual(['client'])
    })

    it('lets the side be changed by hand', async () => {
        const mod = await db.mod.create({ data: { name: 'zoom', pretty_name: 'Zoom' } })
        const modversion = await db.modversion.create({ data: { mod_id: mod.id, version: '1.0', md5: 'x' } })
        const set = async (environment: string) =>
            actingAs(await admin(), { ajax: true, headers: { Accept: 'application/json' } }).postJson(`/mod/version-environment/${modversion.id}`, { environment })

        expect((await set('client')).body).toMatchObject({ status: 'success' })
        expect(await environmentOf(modversion.id)).toBe('client')
        expect((await set('')).body).toMatchObject({ status: 'success' })
        expect(await environmentOf(modversion.id)).toBeNull()
        expect((await set('toaster')).status).toBe(422)
    })

    /** A build with one mod for each side */
    async function sidedBuild(): Promise<Build> {
        const modpack = await db.modpack.create({ data: { name: 'Sided', slug: 'sided' } })
        const build = await db.build.create({ data: { modpack_id: modpack.id, version: '1.0', minecraft: '1.20.1' } })
        for (const [name, environment] of [['shared', null], ['minimap', 'client'], ['backups', 'server']] as const) {
            const mod = await db.mod.create({ data: { name, pretty_name: name[0].toUpperCase() + name.slice(1) } })
            putModversionZip(name, '1.0', { [`mods/${name}.jar`]: `${name}-jar`, [`config/${name}.toml`]: 'x=1' })
            const modversion = await db.modversion.create({ data: { mod_id: mod.id, version: '1.0', md5: 'x', environment } })
            await db.buildModversion.create({ data: { build_id: build.id, modversion_id: modversion.id } })
        }
        return build
    }

    async function exportEntries(build: Build, format: string): Promise<Record<string, string>> {
        const response = await binary(actingAs(await admin()).get(`/modpack/build/${build.id}/export/${format}`)).expect(200)
        const zip = ZipReader.open(response.body as Buffer)!
        return Object.fromEntries(zip.names().sort().map((name) => [name, zip.getText(name) ?? '']))
    }

    it('leaves mods for the other side out of exports', async () => {
        const build = await sidedBuild()
        Http.fake({ 'api.modrinth.com/v2/version_files': { body: [] } })

        const server = Object.keys(await exportEntries(build, 'server'))
        expect(server).toContain('mods/backups.jar')
        expect(server).not.toContain('mods/minimap.jar')

        const client = Object.keys(await exportEntries(build, 'technic'))
        expect(client).toContain('mods/minimap.jar')
        expect(client).not.toContain('mods/backups.jar')

        const curseforge = Object.keys(await exportEntries(build, 'curseforge'))
        expect(curseforge).toContain('overrides/mods/minimap.jar')
        expect(curseforge).not.toContain('overrides/mods/backups.jar')

        const mrpack = Object.keys(await exportEntries(build, 'mrpack'))
        expect(mrpack).toContain('client-overrides/mods/minimap.jar')
        expect(mrpack).toContain('server-overrides/mods/backups.jar')
        expect(mrpack).toContain('overrides/mods/shared.jar')
    })

    it('marks hosted files in an mrpack with their side', async () => {
        const build = await sidedBuild()
        Http.fake({
            'api.modrinth.com/v2/version_files': {
                body: { [sha1('minimap-jar')]: { files: [{ url: 'https://cdn.modrinth.com/minimap.jar', hashes: { sha1: sha1('minimap-jar') } }] } },
            },
        })
        const index = JSON.parse((await exportEntries(build, 'mrpack'))['modrinth.index.json']) as { files: { env: unknown }[] }
        expect(index.files[0].env).toEqual({ client: 'required', server: 'unsupported' })
    })
})
