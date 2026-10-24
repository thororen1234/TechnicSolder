import { createHash } from 'node:crypto'
import { db } from '../../src/database/prisma.js'
import type { Build } from '../../src/models/types.js'
import { actingAs, admin, makeArchive, putModversionZip, useModRepository, useSolder } from '../support/helpers.js'

interface HealthIssue {
    severity: string
    message: string
}

describe('Build health', () => {
    useSolder()
    useModRepository()
    let build: Build

    beforeEach(async () => {
        const modpack = await db.modpack.create({ data: { name: 'Health Pack', slug: 'health-pack' } })
        build = await db.build.create({ data: { modpack_id: modpack.id, version: '1.0', minecraft: '1.20.1' } })
    })

    async function add(modName: string, version: string, files: Record<string, string | Buffer>, storeFile = true): Promise<void> {
        const mod = (await db.mod.findUnique({ where: { name: modName } })) ?? (await db.mod.create({ data: { name: modName, pretty_name: modName[0].toUpperCase() + modName.slice(1) } }))
        if (storeFile) {
            putModversionZip(modName, version, files)
        }
        const modversion = await db.modversion.create({ data: { mod_id: mod.id, version, md5: createHash('md5').update(modName + version).digest('hex') } })
        await db.buildModversion.create({ data: { build_id: build.id, modversion_id: modversion.id } })
    }

    const fabricJar = (id: string, depends: Record<string, string> = {}, extra: object = {}, files: Record<string, Buffer> = {}) =>
        makeArchive({ 'fabric.mod.json': JSON.stringify({ id, version: '1.0', depends, ...extra }), ...files })

    async function health(): Promise<{ checked: number; issues: HealthIssue[] }> {
        return (await actingAs(await admin(), { headers: { Accept: 'application/json' } }).get(`/modpack/build/${build.id}/health`).expect(200)).body
    }

    const messages = async () => (await health()).issues.map((issue) => `${issue.severity}: ${issue.message}`)

    async function addHealthyFabricBase(): Promise<void> {
        await add('fabric-loader', '1.20.1-0.14.9', { 'bin/version.json': '{}' })
        await add('fabric-api', '0.92.0', {
            'mods/fabric-api.jar': fabricJar(
                'fabric-api',
                { fabricloader: '>=0.14', minecraft: '~1.20.1' },
                { jars: [{ file: 'META-INF/jars/fabric-api-base.jar' }] },
                { 'META-INF/jars/fabric-api-base.jar': fabricJar('fabric-api-base') },
            ),
        })
        await add('sodium', '0.5.0', { 'mods/sodium.jar': fabricJar('sodium', { minecraft: '1.20.x', 'fabric-api-base': '*' }) })
    }

    async function publish(extra: object = {}): Promise<Record<string, unknown>> {
        return (await actingAs(await admin(), { ajax: true }).post('/modpack/modify/published', { build: build.id, published: 1, ...extra }).expect(200)).body
    }

    const isPublished = async () => Boolean((await db.build.findUniqueOrThrow({ where: { id: build.id } })).is_published)

    it('finds no issues in a healthy build', async () => {
        await addHealthyFabricBase()
        expect(await messages()).toEqual([])
        expect((await health()).checked).toBe(3)
    })

    it('reports problems that stop a build launching', async () => {
        await addHealthyFabricBase()
        await add('create', '0.5.1', { 'mods/create.jar': makeArchive({ 'META-INF/mods.toml': '[[mods]]\nmodId="create"\nversion="0.5.1"' }) })
        await add('oldmod', '1.0', { 'mods/oldmod.jar': fabricJar('oldmod', { minecraft: '1.19.2' }) })
        await add('needy', '1.0', { 'mods/needy.jar': fabricJar('needy', { 'cloth-config': '*' }) })
        await add('sodium-copy', '0.5.0', { 'mods/sodium-copy.jar': fabricJar('sodium') })
        await add('ghost', '1.0', {}, false)

        const found = await messages()
        expect(found).toContain('error: create.jar is a forge mod, but this build uses fabric.')
        expect(found).toContain('error: needy.jar requires "cloth-config", which isn\'t in this build.')
        expect(found).toContain('error: 1.0: mods/ghost/ghost-1.0.zip is missing from the mod repository')
        expect(found).toContain('warning: oldmod.jar is made for Minecraft 1.19.2, but this build is 1.20.1.')
        expect(found).toContain('warning: sodium is included by both Sodium and Sodium-copy.')
        expect((await health()).issues[0].severity).toBe('error')
    })

    it('reports a missing mod loader', async () => {
        await add('sodium', '0.5.0', { 'mods/sodium.jar': fabricJar('sodium') })
        expect(await messages()).toContain('error: This build has no mod loader. Add Forge, NeoForge, Fabric or Quilt from Mods → Import → Mod loader.')
    })

    it('needs confirmation to publish a build with problems', async () => {
        await add('sodium', '0.5.0', { 'mods/sodium.jar': fabricJar('sodium', { 'cloth-config': '*' }) })
        const response = await publish()
        expect(response.status).toBe('blocked')
        expect(response.reason).toBe('Build 1.0 has 2 problems that may stop it launching.')
        expect(response.issues).toContain('sodium.jar requires "cloth-config", which isn\'t in this build.')
        expect(await isPublished()).toBe(false)

        expect((await publish({ force: 1 })).success).toBe('Build 1.0 is now published')
        expect(await isPublished()).toBe(true)
    })

    it('publishes a healthy build straight away', async () => {
        await addHealthyFabricBase()
        expect((await publish()).success).toBe('Build 1.0 is now published')
        expect(await isPublished()).toBe(true)
    })

    it('accepts Fabric mods in Quilt builds', async () => {
        await add('quilt-loader', '1.20.1-0.29.1', { 'bin/version.json': '{}' })
        await add('sodium', '0.5.0', { 'mods/sodium.jar': fabricJar('sodium') })
        expect(await messages()).toEqual([])
    })

    it('does not report NeoForge mods with the old mods.toml name as Forge', async () => {
        await db.build.update({ where: { id: build.id }, data: { minecraft: '1.20.4' } })
        const toml = '[[mods]]\nmodId="starlight"\nversion="1.1.3"\n[[dependencies.starlight]]\nmodId="neoforge"\nrequired=true\n'
        await add('neoforge', 'neoforge-20.4.237', { 'bin/modpack.jar': 'jar' })
        await add('starlight', '1.1.3', { 'mods/starlight.jar': makeArchive({ 'META-INF/mods.toml': toml }) })
        expect(await messages()).toEqual([])
    })
})
