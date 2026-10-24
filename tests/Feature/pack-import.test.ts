import { createHash } from 'node:crypto'
import { config } from '../../src/config.js'
import { db } from '../../src/database/prisma.js'
import type { Build } from '../../src/models/types.js'
import { Http } from '../../src/support/http.js'
import { ZipReader } from '../../src/support/zip.js'
import { actingAs, admin, fakeFabricMeta, flashed, flashedErrors, makeArchive, makeFabricJar, redirectPath, useModRepository, useSolder } from '../support/helpers.js'

const sha1 = (contents: Buffer) => createHash('sha1').update(contents).digest('hex')

describe('Importing modpacks', () => {
    useSolder()
    const repository = useModRepository()

    async function importPack(contents: Buffer | string, filename: string, slug = 'test-pack') {
        return actingAs(await admin())
            .upload('/modpack/import')
            .field('name', 'Test Pack')
            .field('slug', slug)
            .field('source', 'file')
            .attach('file', Buffer.from(contents), filename)
    }

    /** Mod name => version for every mod version in the build */
    async function buildContents(build: Build): Promise<Record<string, string>> {
        const links = await db.buildModversion.findMany({ where: { build_id: build.id } })
        const modversions = await db.modversion.findMany({ where: { id: { in: links.map((link) => link.modversion_id) } } })
        const mods = await db.mod.findMany({ where: { id: { in: modversions.map((mv) => mv.mod_id) } } })
        const entries = modversions.map((mv) => [mods.find((mod) => mod.id === mv.mod_id)!.name, mv.version] as const)
        return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)))
    }

    function zipEntries(modName: string, version: string): Record<string, string> {
        const zip = ZipReader.open(`${repository.path()}mods/${modName}/${modName}-${version}.zip`)!
        return Object.fromEntries(zip.names().sort().map((name) => [name, zip.getText(name) ?? '']))
    }

    async function soleBuild(): Promise<Build> {
        const modpack = await db.modpack.findFirstOrThrow({ where: { slug: 'test-pack' } })
        const builds = await db.build.findMany({ where: { modpack_id: modpack.id } })
        expect(builds).toHaveLength(1)
        return builds[0]
    }

    const firstError = (response: Parameters<typeof flashedErrors>[0]) => Object.values(flashedErrors(response)).flat()[0] ?? ''
    const header = (headers: Record<string, string>, name: string) => Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1]

    it('imports a Modrinth pack with its loader, resource packs and overrides', async () => {
        const sodium = makeFabricJar('sodium', '0.5.13')
        const resourcePack = makeArchive({ 'pack.mcmeta': '{"pack":{"pack_format":15}}' })
        fakeFabricMeta()
        Http.fake({
            'api.modrinth.com/v2/versions*': {
                body: [
                    {
                        id: 'v1',
                        project_id: 'AANobbMI',
                        version_number: '0.5.13',
                        version_type: 'release',
                        game_versions: ['1.20.1'],
                        loaders: ['fabric'],
                        files: [{ url: 'https://cdn.modrinth.com/data/AANobbMI/versions/v1/sodium.jar', filename: 'sodium.jar', primary: true, hashes: { sha1: sha1(sodium) } }],
                    },
                ],
            },
            'api.modrinth.com/v2/projects*': { body: [{ id: 'AANobbMI', slug: 'sodium', title: 'Sodium', description: 'Fast', project_type: 'mod' }] },
            'cdn.modrinth.com/data/AANobbMI/versions/v1/sodium.jar': { body: sodium },
            'example.com/faithful-1.2.zip': { body: resourcePack },
        })
        const pack = makeArchive({
            'modrinth.index.json': JSON.stringify({
                formatVersion: 1,
                game: 'minecraft',
                versionId: '5.4.1',
                name: 'Fabulous',
                files: [
                    {
                        path: 'mods/sodium.jar',
                        downloads: ['https://cdn.modrinth.com/data/AANobbMI/versions/v1/sodium.jar'],
                        hashes: { sha1: sha1(sodium) },
                        env: { client: 'required', server: 'required' },
                    },
                    { path: 'resourcepacks/faithful-1.2.zip', downloads: ['https://example.com/faithful-1.2.zip'], hashes: { sha1: sha1(resourcePack) } },
                    { path: 'mods/server-only.jar', downloads: ['https://example.com/server-only.jar'], env: { client: 'unsupported', server: 'required' } },
                ],
                dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.14.9' },
            }),
            'overrides/config/sodium.json': '{"quality":"fast"}',
            'client-overrides/options.txt': 'fov:90',
        })

        const response = await importPack(pack, 'fabulous.mrpack')

        const modpack = await db.modpack.findFirstOrThrow({ where: { slug: 'test-pack' } })
        expect(redirectPath(response)).toBe(`/modpack/view/${modpack.id}`)
        expect(flashedErrors(response)).toEqual({})
        expect(flashed(response).success).toBe('3 mod(s) imported.')
        expect(Boolean(modpack.hidden)).toBe(true)
        const build = await soleBuild()
        expect(build.version).toBe('5.4.1')
        expect(build.minecraft).toBe('1.20.1')
        expect(await buildContents(build)).toEqual({
            'fabric-loader': '1.20.1-0.14.9',
            faithful: '1.20.1-faithful-1.2',
            sodium: '1.20.1-0.5.13',
            'test-pack-overrides': '5.4.1',
        })
        expect(Object.keys(zipEntries('faithful', '1.20.1-faithful-1.2'))).toEqual(['resourcepacks/faithful-1.2.zip'])
        expect(zipEntries('test-pack-overrides', '5.4.1')).toEqual({ 'config/sodium.json': '{"quality":"fast"}', 'options.txt': 'fov:90' })
        expect(Http.recorded().some((request) => request.url.includes('server-only'))).toBe(false)
    })

    it('imports a CurseForge pack with Forge and overrides', async () => {
        config.solder.curseforge_api_key = 'test-key'
        const jei = makeArchive({ 'mcmod.info': JSON.stringify([{ version: '15.2.0', mcversion: '1.20.1' }]) })
        Http.fake({
            'api.curseforge.com/v1/mods/files': {
                body: {
                    data: [
                        {
                            id: 111,
                            modId: 238222,
                            displayName: 'jei-1.20.1-15.2.0',
                            fileName: 'jei.jar',
                            downloadUrl: 'https://edge.forgecdn.net/files/111/jei.jar',
                            gameVersions: ['1.20.1', 'Forge'],
                            releaseType: 1,
                        },
                    ],
                },
            },
            'api.curseforge.com/v1/mods': { body: { data: [{ id: 238222, slug: 'jei', name: 'Just Enough Items', classId: 6, authors: [{ name: 'mezz' }] }] } },
            'edge.forgecdn.net/files/111/jei.jar': { body: jei },
            'maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml': {
                body: '<metadata><versioning><versions><version>1.20.1-47.2.0</version></versions></versioning></metadata>',
            },
            'maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.2.0/*': { body: makeArchive({ 'install_profile.json': '{}' }) },
        })
        const pack = makeArchive({
            'manifest.json': JSON.stringify({
                minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.2.0', primary: true }] },
                manifestType: 'minecraftModpack',
                manifestVersion: 1,
                name: 'CF Pack',
                version: '2.0.0',
                files: [
                    { projectID: 238222, fileID: 111, required: true },
                    { projectID: 999, fileID: 222, required: false },
                ],
                overrides: 'overrides',
            }),
            'overrides/config/jei.toml': 'enabled = true',
        })

        const response = await importPack(pack, 'cf-pack.zip')

        expect(flashedErrors(response)).toEqual({})
        const build = await soleBuild()
        expect(build.forge).toBe('forge-47.2.0')
        expect(await buildContents(build)).toEqual({ forge: '1.20.1-forge-47.2.0', jei: '1.20.1-15.2.0', 'test-pack-overrides': '2.0.0' })
        expect(Object.keys(zipEntries('forge', '1.20.1-forge-47.2.0'))).toEqual(['bin/modpack.jar'])
        const recorded = Http.recorded()
        expect(
            recorded.some((request) => request.url === 'https://api.curseforge.com/v1/mods/files' && JSON.stringify((JSON.parse(request.body ?? '{}') as { fileIds?: unknown }).fileIds) === '[111]'),
        ).toBe(true)
        expect(recorded.some((request) => request.url.includes('forgecdn') && header(request.headers, 'x-api-key') === undefined)).toBe(true)
    })

    it('rejects a CurseForge pack without an API key before creating anything', async () => {
        config.solder.curseforge_api_key = ''
        const pack = makeArchive({
            'manifest.json': JSON.stringify({
                minecraft: { version: '1.20.1', modLoaders: [] },
                manifestType: 'minecraftModpack',
                files: [{ projectID: 1, fileID: 2, required: true }],
            }),
        })
        const response = await importPack(pack, 'cf-pack.zip')
        expect(redirectPath(response)).toBe('/modpack/import')
        expect(firstError(response)).toContain('CURSEFORGE_API_KEY')
        expect(await db.modpack.count({ where: { slug: 'test-pack' } })).toBe(0)
        expect(Http.recorded()).toEqual([])
    })

    it('reports an unavailable loader version without failing the import', async () => {
        fakeFabricMeta()
        const pack = makeArchive({
            'modrinth.index.json': JSON.stringify({
                formatVersion: 1,
                game: 'minecraft',
                versionId: '1.0',
                files: [],
                dependencies: { minecraft: '1.20.1', 'fabric-loader': '9.9.9' },
            }),
        })
        const response = await importPack(pack, 'pack.mrpack')
        const modpack = await db.modpack.findFirstOrThrow({ where: { slug: 'test-pack' } })
        expect(redirectPath(response)).toBe(`/modpack/view/${modpack.id}`)
        expect(firstError(response)).toContain('Could not find fabric 9.9.9 for Minecraft 1.20.1')
    })

    it('rejects an unrecognized archive', async () => {
        const response = await importPack(makeArchive({ 'readme.txt': 'hi' }), 'random.zip')
        expect(redirectPath(response)).toBe('/modpack/import')
        expect(firstError(response)).toContain('Unrecognized modpack format')
        expect(await db.modpack.count({ where: { slug: 'test-pack' } })).toBe(0)
    })

    it('rejects an upload that is not an archive', async () => {
        const response = await importPack('definitely not a zip', 'pack.zip')
        expect(redirectPath(response)).toBe('/modpack/import')
        expect(firstError(response)).toContain('Could not open the archive')
    })
})
