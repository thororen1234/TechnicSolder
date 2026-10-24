import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { config } from '../../src/config.js'
import { db } from '../../src/database/prisma.js'
import type { VersionData } from '../../src/mods/imported-mod-data.js'
import { latestStableVersionForGame } from '../../src/mods/mod-provider.js'
import { CurseForge } from '../../src/mods/providers/curseforge.js'
import { Fabric, Quilt } from '../../src/mods/providers/fabric.js'
import { Forge } from '../../src/mods/providers/forge.js'
import { Modrinth } from '../../src/mods/providers/modrinth.js'
import { NeoForge } from '../../src/mods/providers/neoforge.js'
import type { Modversion } from '../../src/models/types.js'
import { Http } from '../../src/support/http.js'
import { ZipReader } from '../../src/support/zip.js'
import { actingAs, fakeFabricMeta, makeArchive, makeFabricJar, makeUser, redirectPath, useModRepository, useSolder } from '../support/helpers.js'

const sha1 = (contents: string | Buffer) => createHash('sha1').update(contents).digest('hex')
const md5 = (contents: Buffer) => createHash('md5').update(contents).digest('hex')

describe('Mod providers', () => {
    useSolder()
    const repository = useModRepository()

    /** Fake a Modrinth project "sodium" whose versions serve the given file contents */
    function fakeModrinthProject(versions: Record<string, { contents: string | Buffer; loaders?: string[]; game?: string; sha1?: string; status?: number }>): void {
        const fakes: Parameters<typeof Http.fake>[0] = {
            'api.modrinth.com/v2/project/sodium': { body: { id: 'AANobbMI', slug: 'sodium', title: 'Sodium', description: 'Fast', project_type: 'mod' } },
            'api.modrinth.com/v2/project/sodium/members': { body: [{ role: 'Owner', user: { username: 'jellysquid3' } }] },
            'api.modrinth.com/v2/project/sodium/version': {
                body: Object.entries(versions).map(([id, version]) => ({
                    id,
                    version_number: `${id}-number`,
                    version_type: 'release',
                    game_versions: [version.game ?? '1.20.1'],
                    loaders: version.loaders ?? ['fabric'],
                    files: [
                        {
                            url: `https://cdn.modrinth.com/data/AANobbMI/versions/${id}/sodium.jar`,
                            filename: 'sodium.jar',
                            primary: true,
                            hashes: { sha1: version.sha1 ?? sha1(version.contents) },
                        },
                    ],
                })),
            },
        }
        for (const [id, version] of Object.entries(versions)) {
            fakes[`cdn.modrinth.com/data/AANobbMI/versions/${id}/sodium.jar`] = { body: version.contents, status: version.status ?? 200 }
        }
        Http.fake(fakes)
    }

    const zipPath = (modName: string, version: string) => `${repository.path()}mods/${modName}/${modName}-${version}.zip`

    async function storedEntries(modversion: Modversion): Promise<string[]> {
        const mod = await db.mod.findUniqueOrThrow({ where: { id: modversion.mod_id } })
        return ZipReader.open(zipPath(mod.name, modversion.version))!.names()
    }

    const modversion = (id: number | undefined) => db.modversion.findUniqueOrThrow({ where: { id } })
    const requested = (part: string) => Http.recorded().some((request) => request.url.includes(part))

    it('stores a Modrinth jar under its detected version', async () => {
        fakeModrinthProject({ v1: { contents: makeFabricJar('sodium', '0.5.13') } })
        const result = await Modrinth.install('sodium', ['v1'])
        expect(result.success).toBe(true)
        expect(result.errors).toEqual([])
        const mod = await db.mod.findUniqueOrThrow({ where: { name: 'sodium' } })
        expect(mod.pretty_name).toBe('Sodium')
        expect(mod.author).toBe('jellysquid3')
        const stored = await modversion(result.modversionIds.get('v1'))
        expect(stored.version).toBe('1.20.1-0.5.13')
        expect(await storedEntries(stored)).toEqual(['mods/sodium.jar'])
        expect(stored.md5).toBe(md5(readFileSync(zipPath('sodium', '1.20.1-0.5.13'))))
    })

    it('reuses a version imported before', async () => {
        fakeModrinthProject({ v1: { contents: makeFabricJar('sodium', '0.5.13') } })
        const first = await Modrinth.install('sodium', ['v1'])
        const second = await Modrinth.install('sodium', ['v1'])
        expect(second.modversionIds).toEqual(first.modversionIds)
        expect(second.existing).toBe(1)
        expect(second.errors).toEqual([])
        expect(await db.modversion.count({ where: { mod_id: first.id } })).toBe(1)
    })

    it('reports a failed download and stores nothing', async () => {
        fakeModrinthProject({ v1: { contents: 'Not Found', status: 404 } })
        const result = await Modrinth.install('sodium', ['v1'])
        expect(result.errors[0]).toContain('HTTP 404')
        expect(result.modversionIds.size).toBe(0)
        const sodium = await db.mod.findUnique({ where: { name: 'sodium' } })
        expect(sodium === null ? 0 : await db.modversion.count({ where: { mod_id: sodium.id } })).toBe(0)
        expect(existsSync(`${repository.path()}mods/sodium`)).toBe(false)
    })

    it('rejects a checksum mismatch', async () => {
        fakeModrinthProject({ v1: { contents: makeFabricJar('sodium', '0.5.13'), sha1: '0'.repeat(40) } })
        const result = await Modrinth.install('sodium', ['v1'])
        expect(result.errors[0]).toContain('checksum mismatch')
        expect(result.modversionIds.size).toBe(0)
    })

    it('rejects a download that is not an archive', async () => {
        fakeModrinthProject({ v1: { contents: '<html>rate limited</html>' } })
        expect((await Modrinth.install('sodium', ['v1'])).errors[0]).toContain('not a valid jar or zip')
    })

    it('uses the provider version name for a file without metadata', async () => {
        fakeModrinthProject({ v1: { contents: makeArchive({ 'pack.mcmeta': '{}' }) } })
        const result = await Modrinth.install('sodium', ['v1'])
        expect((await modversion(result.modversionIds.get('v1'))).version).toBe('1.20.1-v1-number')
    })

    it('cannot import into a remote repository', async () => {
        config.solder.repo_location = 'https://mods.example.com/'
        fakeModrinthProject({ v1: { contents: makeFabricJar('sodium', '0.5.13') } })
        const result = await Modrinth.install('sodium', ['v1'])
        expect(result.errors[0]).toContain('remote URL')
        expect(requested('cdn.modrinth.com')).toBe(false)
    })

    it('picks the latest version for a loader, game version and channel', () => {
        const versions = new Map(
            Object.entries({
                'newest-forge': { gameVersions: ['1.20.1'], loaders: ['forge'], versionType: 'release' },
                'beta-fabric': { gameVersions: ['1.20.1'], loaders: ['fabric'], versionType: 'beta' },
                fabric: { gameVersions: ['1.20.1'], loaders: ['fabric'], versionType: 'release' },
                'old-fabric': { gameVersions: ['1.19.2'], loaders: ['fabric'], versionType: 'release' },
            }) as [string, VersionData][],
        )
        expect(latestStableVersionForGame(versions, '1.20.1', 'release', 'fabric')).toBe('fabric')
        expect(latestStableVersionForGame(versions, '1.20.1', 'any', 'fabric')).toBe('beta-fabric')
        expect(latestStableVersionForGame(versions, '1.19.2', '', 'fabric')).toBe('old-fabric')
        expect(latestStableVersionForGame(versions, '', 'release')).toBe('newest-forge')
        expect(latestStableVersionForGame(versions, '1.20.1', 'alpha')).toBeNull()
    })

    it('flags unstable Fabric loaders and stores the profile in bin', async () => {
        fakeFabricMeta()
        const modData = (await Fabric.mod('1.20.1'))!
        expect(modData.versions.get('1.20.1-0.15.0')?.versionType).toBe('beta')
        expect(modData.versions.get('1.20.1-0.14.9')?.versionType).toBe('release')
        expect(latestStableVersionForGame(modData.versions, '1.20.1', 'release')).toBe('1.20.1-0.14.9')

        const result = await Fabric.install('1.20.1', ['1.20.1-0.14.9'], modData)
        const stored = await modversion(result.modversionIds.get('1.20.1-0.14.9'))
        expect((await db.mod.findUniqueOrThrow({ where: { id: stored.mod_id } })).name).toBe('fabric-loader')
        expect(stored.version).toBe('1.20.1-0.14.9')
        expect(await storedEntries(stored)).toEqual(['bin/version.json'])
    })

    it('supports year-based Minecraft versions for Fabric', async () => {
        fakeFabricMeta()
        const modData = (await Fabric.mod('26.1'))!
        expect(modData.displayName).toBe('Fabric Loader 26.1')
        expect(modData.versions.get('26.1-0.14.9')?.url).toBe('https://meta.fabricmc.net/v2/versions/loader/26.1/0.14.9/profile/json')
    })

    it('flags beta Quilt loaders', async () => {
        Http.fake({
            'meta.quiltmc.org/v3/versions/game': { body: [{ version: '1.20.1', stable: true }] },
            'meta.quiltmc.org/v3/versions/loader': { body: [{ version: '0.30.0-beta.2' }, { version: '0.29.1' }] },
        })
        const modData = (await Quilt.mod('1.20.1'))!
        expect(modData.slug).toBe('quilt-loader')
        expect(modData.versions.get('1.20.1-0.30.0-beta.2')?.versionType).toBe('beta')
        expect(modData.versions.get('1.20.1-0.29.1')?.versionType).toBe('release')
    })

    it('uses the Forge universal jar up to 1.12.2 and the installer after', async () => {
        Http.fake({
            'maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml': {
                body:
                    '<metadata><versioning><versions>' +
                    '<version>1.12.2-14.23.5.2860</version><version>1.20.1-47.2.0</version><version>26.1-62.0.1</version>' +
                    '</versions></versioning></metadata>',
            },
        })
        expect((await Forge.mod('1.12.2'))!.versions.get('1.12.2-forge-14.23.5.2860')?.url).toMatch(/1\.12\.2-14\.23\.5\.2860\/forge-1\.12\.2-14\.23\.5\.2860-universal\.jar$/)
        expect((await Forge.mod('1.20.1'))!.versions.get('1.20.1-forge-47.2.0')?.url).toMatch(/1\.20\.1-47\.2\.0\/forge-1\.20\.1-47\.2\.0-installer\.jar$/)
        expect((await Forge.mod('26.1'))!.versions.get('26.1-forge-62.0.1')?.url).toMatch(/-installer\.jar$/)
        expect((await Forge.search('')).mods.map((mod) => mod.id)).toEqual(['26.1', '1.20.1', '1.12.2'])
    })

    it.each([
        ['legacy forge artifact', '1.20.1-47.1.106', '1.20.1'],
        ['minor release', '20.4.80-beta', '1.20.4'],
        ['first build of a major', '21.0.167', '1.21'],
        ['patch release', '21.1.263', '1.21.1'],
        ['year based', '26.3.0.95', '26.3'],
        ['year based hotfix', '26.3.1.4', '26.3.1'],
    ])('maps the NeoForge version of a %s to Minecraft', (_name, version, minecraft) => {
        expect(NeoForge.minecraftVersion(version)).toBe(minecraft)
    })

    it('builds NeoForge installer URLs for both artifacts', async () => {
        Http.fake({
            'maven.neoforged.net/releases/net/neoforged/forge/maven-metadata.xml': {
                body: '<metadata><versioning><versions><version>1.20.1-47.1.106</version></versions></versioning></metadata>',
            },
            'maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml': {
                body: '<metadata><versioning><versions><version>26.3.0.94-beta</version><version>26.3.0.95-beta</version></versions></versioning></metadata>',
            },
        })
        const legacy = (await NeoForge.mod('1.20.1'))!
        expect(legacy.versions.get('forge-1.20.1-47.1.106')?.url).toMatch(/\/forge\/1\.20\.1-47\.1\.106\/forge-1\.20\.1-47\.1\.106-installer\.jar$/)
        const current = (await NeoForge.mod('26.3'))!
        expect([...current.versions.keys()]).toEqual(['neoforge-26.3.0.95-beta', 'neoforge-26.3.0.94-beta'])
        expect(current.versions.get('neoforge-26.3.0.95-beta')?.versionType).toBe('beta')
    })

    it('needs an API key for CurseForge', async () => {
        config.solder.curseforge_api_key = ''
        expect((await CurseForge.search('jei')).errors).toHaveProperty('no_api_key')
        expect(await CurseForge.mod('238222')).toBeNull()
        expect(Http.recorded()).toEqual([])
    })

    it('filters CurseForge files and reports disabled downloads', async () => {
        config.solder.curseforge_api_key = 'test-key'
        Http.fake({
            'api.curseforge.com/v1/mods/238222': { body: { data: { id: 238222, slug: 'jei', name: 'Just Enough Items', classId: 6, authors: [{ name: 'mezz' }] } } },
            'api.curseforge.com/v1/mods/238222/files*': {
                body: {
                    data: [
                        { id: 111, modId: 238222, displayName: 'jei-1.20.1-15.2.0', fileName: 'jei.jar', downloadUrl: null, gameVersions: ['1.20.1', 'Forge'], releaseType: 1 },
                    ],
                },
            },
        })
        const modData = await CurseForge.modFor('238222', '1.20.1', 'forge')
        const result = await CurseForge.install('238222', ['111'], modData)
        expect(
            Http.recorded().some(
                (request) =>
                    request.url.includes('/files?') &&
                    request.url.includes('gameVersion=1.20.1') &&
                    request.url.includes('modLoaderType=1') &&
                    Object.entries(request.headers).some(([name, value]) => name.toLowerCase() === 'x-api-key' && value === 'test-key'),
            ),
        ).toBe(true)
        expect(modData?.versions.get('111')?.loaders).toEqual(['forge'])
        expect(result.errors[0]).toContain('disabled third-party downloads')
    })

    it('needs the create permission to import mods', async () => {
        const viewer = await makeUser()
        expect(redirectPath(await actingAs(viewer).get('/mod/import'))).toBe('/dashboard')
        expect(redirectPath(await actingAs(viewer).post('/mod/import/batch', { provider: 'fabric', mods: ['1.20.1'] }))).toBe('/dashboard')
        expect(Http.recorded()).toEqual([])
    })
})
