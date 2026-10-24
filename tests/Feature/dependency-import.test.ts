import { config } from '../../src/config.js'
import { db } from '../../src/database/prisma.js'
import { CurseForge } from '../../src/mods/providers/curseforge.js'
import { Http, type FakeResponse } from '../../src/support/http.js'
import { actingAs, admin, flashed, flashedErrors, makeFabricJar, useModRepository, useSolder } from '../support/helpers.js'

/** A fake Modrinth project with one version */
function modrinthProject(id: string, slug: string, title: string, versionId: string, version: string, dependencies: { project_id: string; dependency_type: string }[] = []) {
    return {
        [`api.modrinth.com/v2/project/${id}`]: { body: { id, slug, title, project_type: 'mod' } },
        [`api.modrinth.com/v2/project/${id}/members`]: { body: [] },
        [`api.modrinth.com/v2/project/${id}/version*`]: {
            body: [
                {
                    id: versionId,
                    version_number: version,
                    version_type: 'release',
                    game_versions: ['1.20.1'],
                    loaders: ['fabric'],
                    dependencies,
                    files: [{ url: `https://cdn.modrinth.com/data/${id}/versions/${versionId}/${slug}.jar`, filename: `${slug}.jar`, primary: true }],
                },
            ],
        },
        [`cdn.modrinth.com/data/${id}/versions/${versionId}/${slug}.jar`]: { body: makeFabricJar(slug, version) },
    } satisfies Record<string, FakeResponse>
}

describe('Importing required mods', () => {
    useSolder()
    useModRepository()

    function fakeIrisAndSodium(): void {
        Http.fake({
            ...modrinthProject('YL57xq9U', 'iris', 'Iris', 'iris-v1', '1.7.0', [
                { project_id: 'AANobbMI', dependency_type: 'required' },
                { project_id: 'optional', dependency_type: 'optional' },
            ]),
            ...modrinthProject('AANobbMI', 'sodium', 'Sodium', 'sodium-v1', '0.5.0'),
        })
    }

    async function importIris(withDependencies: boolean) {
        return actingAs(await admin()).post('/mod/import/details/modrinth/YL57xq9U', {
            versions: [Buffer.from('iris-v1').toString('base64')],
            ...(withDependencies ? { with_dependencies: 1 } : {}),
        })
    }

    const requested = (part: string) => Http.recorded().some((request) => request.url.includes(part))

    it('also imports the required mods', async () => {
        fakeIrisAndSodium()
        const response = await importIris(true)
        expect(flashedErrors(response)).toEqual({})
        expect(flashed(response).success).toBe('Imported 1 version. Also imported required mods: Sodium 0.5.0.')
        const sodium = await db.mod.findUniqueOrThrow({ where: { name: 'sodium' } })
        expect((await db.modversion.findMany({ where: { mod_id: sodium.id } })).map((mv) => mv.version)).toEqual(['1.20.1-0.5.0'])
        expect(requested('project/optional')).toBe(false)
    })

    it('does not import required mods already in the library again', async () => {
        fakeIrisAndSodium()
        const sodium = await db.mod.create({ data: { name: 'sodium', pretty_name: 'Sodium' } })
        await db.modversion.create({
            data: { mod_id: sodium.id, version: '0.4.0', md5: 'x', provider: 'modrinth', provider_project_id: 'AANobbMI', provider_version_id: 'old' },
        })
        expect(flashed(await importIris(true)).success).toBe('Imported 1 version.')
        expect((await db.modversion.findMany({ where: { mod_id: sodium.id } })).map((mv) => mv.version)).toEqual(['0.4.0'])
        expect(requested('project/AANobbMI')).toBe(false)
    })

    it('leaves required mods alone when not asked for', async () => {
        fakeIrisAndSodium()
        expect(flashed(await importIris(false)).success).toBe('Imported 1 version.')
        expect(await db.mod.count({ where: { name: 'sodium' } })).toBe(0)
    })

    it('reports a required mod without a compatible version', async () => {
        Http.fake({
            ...modrinthProject('YL57xq9U', 'iris', 'Iris', 'iris-v1', '1.7.0', [{ project_id: 'AANobbMI', dependency_type: 'required' }]),
            'api.modrinth.com/v2/project/AANobbMI': { body: { id: 'AANobbMI', slug: 'sodium', title: 'Sodium' } },
            'api.modrinth.com/v2/project/AANobbMI/members': { body: [] },
            'api.modrinth.com/v2/project/AANobbMI/version*': { body: [] },
        })
        const response = await importIris(true)
        expect(Object.values(flashedErrors(response)).flat()).toEqual(['Iris requires Sodium, but no version for 1.20.1 fabric was found. Add it by hand.'])
        expect(await db.mod.count({ where: { name: 'iris' } })).toBe(1)
    })

    it('records the required mods of CurseForge files', async () => {
        config.solder.curseforge_api_key = 'test-key'
        Http.fake({
            'api.curseforge.com/v1/mods/111': { body: { data: { id: 111, slug: 'create', name: 'Create', classId: 6 } } },
            'api.curseforge.com/v1/mods/111/files*': {
                body: {
                    data: [
                        {
                            id: 9,
                            modId: 111,
                            fileName: 'create.jar',
                            downloadUrl: 'https://edge.forgecdn.net/create.jar',
                            gameVersions: ['1.20.1', 'Forge'],
                            dependencies: [
                                { modId: 222, relationType: 3 },
                                { modId: 333, relationType: 2 },
                            ],
                        },
                    ],
                },
            },
        })
        expect((await CurseForge.mod('111'))?.versions.get('9')?.dependencies).toEqual(['222'])
    })
})
