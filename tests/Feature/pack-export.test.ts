import { createHash } from 'node:crypto'
import { readFileSync, statSync, unlinkSync } from 'node:fs'
import { db } from '../../src/database/prisma.js'
import type { Build, Modpack, Modversion } from '../../src/models/types.js'
import { Http } from '../../src/support/http.js'
import { ZipReader } from '../../src/support/zip.js'
import {
    actingAs,
    admin,
    binary,
    flashedErrors,
    makeArchive,
    makeFabricJar,
    makeUser,
    putModversionZip,
    redirectPath,
    useModRepository,
    useSolder,
} from '../support/helpers.js'

const hash = (algorithm: string, contents: Buffer) => createHash(algorithm).update(contents).digest('hex')

describe('Exporting builds', () => {
    useSolder()
    const repository = useModRepository()
    const sodiumJar = makeFabricJar('sodium', '0.5.13')
    let modpack: Modpack
    let build: Build

    async function addModversion(modName: string, version: string, files: Record<string, string | Buffer>, to?: Build): Promise<Modversion> {
        const mod = (await db.mod.findUnique({ where: { name: modName } })) ?? (await db.mod.create({ data: { name: modName, pretty_name: modName[0].toUpperCase() + modName.slice(1) } }))
        putModversionZip(modName, version, files)
        const path = `${repository.path()}mods/${modName}/${modName}-${version}.zip`
        const modversion = await db.modversion.create({ data: { mod_id: mod.id, version, md5: hash('md5', readFileSync(path)), filesize: statSync(path).size } })
        await db.buildModversion.create({ data: { build_id: (to ?? build).id, modversion_id: modversion.id } })
        return modversion
    }

    beforeEach(async () => {
        modpack = await db.modpack.create({ data: { name: 'Export Pack', slug: 'export-pack' } })
        build = await db.build.create({ data: { modpack_id: modpack.id, version: '1.0.0', minecraft: '1.20.1' } })
        await addModversion('fabric-loader', '1.20.1-0.14.9', { 'bin/version.json': '{"id":"fabric"}' })
        await addModversion('sodium', '1.20.1-0.5.13', { 'mods/sodium.jar': sodiumJar })
        await addModversion('mystery', '1.0', { 'mods/mystery.jar': makeFabricJar('mystery', '1.0') })
        await addModversion('export-pack-overrides', '1.0.0', { 'config/sodium.json': '{"quality":"fast"}' })
    })

    /** Download an export and return its entries as name => contents */
    async function exportBuild(format: string, of?: Build): Promise<Record<string, Buffer>> {
        const response = await binary(actingAs(await admin()).get(`/modpack/build/${(of ?? build).id}/export/${format}`)).expect(200)
        const zip = ZipReader.open(response.body as Buffer)!
        return Object.fromEntries(zip.names().sort().map((name) => [name, zip.getFromName(name) ?? Buffer.alloc(0)]))
    }

    const text = (entries: Record<string, Buffer>, name: string) => entries[name].toString('utf8')

    it('merges every mod version into the client zip', async () => {
        const response = await actingAs(await admin()).get(`/modpack/build/${build.id}/export/technic`).expect(200)
        expect(response.headers['content-disposition']).toMatch(/^attachment; filename="?export-pack-1\.0\.0\.zip"?$/)
        expect(Object.keys(await exportBuild('technic'))).toEqual(['bin/version.json', 'config/sodium.json', 'mods/mystery.jar', 'mods/sodium.jar'])
    })

    it('leaves the client profile out of the server zip and explains the loader', async () => {
        const entries = await exportBuild('server')
        expect(Object.keys(entries)).toEqual(['README.txt', 'config/sodium.json', 'mods/mystery.jar', 'mods/sodium.jar'])
        expect(text(entries, 'README.txt')).toContain('Fabric Loader 0.14.9')
        expect(text(entries, 'README.txt')).toContain('https://fabricmc.net/use/server/')
    })

    it('includes the Forge installer in the server zip', async () => {
        const forgeBuild = await db.build.create({ data: { modpack_id: modpack.id, version: '2.0.0', minecraft: '1.20.1' } })
        await addModversion('forge', '1.20.1-forge-47.2.0', { 'bin/modpack.jar': makeArchive({ 'install_profile.json': '{}' }) }, forgeBuild)
        const entries = await exportBuild('server', forgeBuild)
        expect(entries).toHaveProperty('installer.jar')
        expect(entries).not.toHaveProperty('bin/modpack.jar')
        expect(text(entries, 'README.txt')).toContain('java -jar installer.jar --installServer')
    })

    it('references Modrinth-hosted jars in an mrpack and bundles the rest', async () => {
        const hashes = { sha1: hash('sha1', sodiumJar), sha512: hash('sha512', sodiumJar) }
        Http.fake({
            'api.modrinth.com/v2/version_files': { body: { [hashes.sha1]: { files: [{ url: 'https://cdn.modrinth.com/data/AANobbMI/versions/v1/sodium.jar', hashes }] } } },
        })
        const entries = await exportBuild('mrpack')
        const index = JSON.parse(text(entries, 'modrinth.index.json')) as Record<string, unknown>
        expect(Object.keys(entries)).toEqual(['modrinth.index.json', 'overrides/config/sodium.json', 'overrides/mods/mystery.jar'])
        expect(index.versionId).toBe('1.0.0')
        expect(index.dependencies).toEqual({ minecraft: '1.20.1', 'fabric-loader': '0.14.9' })
        expect(index.files).toEqual([
            {
                path: 'mods/sodium.jar',
                hashes,
                env: { client: 'required', server: 'required' },
                downloads: ['https://cdn.modrinth.com/data/AANobbMI/versions/v1/sodium.jar'],
                fileSize: sodiumJar.length,
            },
        ])
    })

    it('writes a manifest and overrides into a CurseForge zip', async () => {
        const entries = await exportBuild('curseforge')
        const manifest = JSON.parse(text(entries, 'manifest.json')) as { minecraft: { modLoaders: unknown }; manifestType: string; overrides: string }
        expect(Object.keys(entries)).toEqual(['manifest.json', 'overrides/config/sodium.json', 'overrides/mods/mystery.jar', 'overrides/mods/sodium.jar'])
        expect(manifest.minecraft.modLoaders).toEqual([{ id: 'fabric-0.14.9', primary: true }])
        expect(manifest.manifestType).toBe('minecraftModpack')
        expect(manifest.overrides).toBe('overrides')
    })

    it('lists missing files instead of failing the export', async () => {
        unlinkSync(`${repository.path()}mods/mystery/mystery-1.0.zip`)
        const entries = await exportBuild('technic')
        expect(entries).not.toHaveProperty('mods/mystery.jar')
        expect(text(entries, 'EXPORT_WARNINGS.txt')).toContain('mystery 1.0')
    })

    it('does not find an unknown format', async () => {
        await actingAs(await admin()).get(`/modpack/build/${build.id}/export/zipfile`).expect(404)
    })

    it('needs access to the modpack', async () => {
        const outsider = await makeUser()
        expect(redirectPath(await actingAs(outsider).get(`/modpack/build/${build.id}/export/technic`))).toBe('/dashboard')
        expect(redirectPath(await actingAs(outsider).get(`/modpack/export/${modpack.id}`))).toBe('/dashboard')
    })

    it('restores builds and mod versions from a backup', async () => {
        await db.modpack.update({ where: { id: modpack.id }, data: { recommended: '1.0.0', latest: '1.0.0' } })
        const response = await binary(actingAs(await admin()).get(`/modpack/export/${modpack.id}`)).expect(200)
        expect(response.headers['content-disposition']).toMatch(/^attachment; filename="?export-pack-solder-backup\.json"?$/)
        const backup = response.body as Buffer
        expect((JSON.parse(backup.toString('utf8')) as { format: string }).format).toBe('solder-modpack')

        const restore = await actingAs(await admin())
            .upload('/modpack/import')
            .field('name', 'Restored Pack')
            .field('slug', 'restored-pack')
            .field('source', 'file')
            .attach('file', backup, 'backup.json')
        expect(flashedErrors(restore)).toEqual({})

        const restored = await db.modpack.findFirstOrThrow({ where: { slug: 'restored-pack' } })
        expect(restored.recommended).toBe('1.0.0')
        const restoredBuilds = await db.build.findMany({ where: { modpack_id: restored.id } })
        expect(restoredBuilds).toHaveLength(1)
        expect(restoredBuilds[0].minecraft).toBe('1.20.1')
        const modversionIds = async (of: Build) => (await db.buildModversion.findMany({ where: { build_id: of.id } })).map((link) => link.modversion_id).sort()
        expect(await modversionIds(restoredBuilds[0])).toEqual(await modversionIds(build))
    })
})
