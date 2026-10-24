import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { config } from '../../src/config.js'
import { db } from '../../src/database/prisma.js'
import { route } from '../../src/http/urls.js'
import type { Modversion } from '../../src/models/types.js'
import type { Task } from '../../src/services/task-tracker.js'
import { ZipReader } from '../../src/support/zip.js'
import {
    actingAs,
    admin,
    expectSee,
    flashed,
    flashedErrors,
    lastView,
    makeArchive,
    makeUser,
    putModversionZip,
    redirectPath,
    useModRepository,
    useSolder,
} from '../support/helpers.js'

const md5File = (path: string) => createHash('md5').update(readFileSync(path)).digest('hex')

describe('Checking the mod repository', () => {
    useSolder()
    const repository = useModRepository()

    async function modversion(name: string, version: string, options: { storedMd5?: string; storeFile?: boolean } = {}): Promise<Modversion> {
        const mod = (await db.mod.findUnique({ where: { name } })) ?? (await db.mod.create({ data: { name, pretty_name: name[0].toUpperCase() + name.slice(1) } }))
        let md5 = 'missing'
        if (options.storeFile ?? true) {
            putModversionZip(name, version, { [`mods/${name}.jar`]: name + version })
            md5 = md5File(`${repository.path()}mods/${name}/${name}-${version}.zip`)
        }
        return db.modversion.create({ data: { mod_id: mod.id, version, md5: options.storedMd5 ?? md5, filesize: 1 } })
    }

    /** Run the check and return its problems for the mods created in the test, keyed by mod name */
    async function runCheck(): Promise<Record<string, string>> {
        const response = await actingAs(await admin()).post('/solder/repository').expect(302)
        const location = new URL(response.headers.location)
        await actingAs(await admin()).get(location.pathname + location.search).expect(200)
        const problems = ((lastView()?.data.task as Task).result?.problems ?? []) as { mod: string; problem: string }[]
        return Object.fromEntries(problems.filter((problem) => ['Good', 'Edited', 'Gone'].includes(problem.mod)).map((problem) => [problem.mod, problem.problem]))
    }

    it('reports missing and changed files', async () => {
        await modversion('good', '1.0')
        await modversion('edited', '1.0', { storedMd5: '0'.repeat(32) })
        await modversion('gone', '1.0', { storeFile: false })
        expect(await runCheck()).toEqual({ Edited: 'changed', Gone: 'missing' })
    })

    it('accepts changed files by updating their checksums', async () => {
        const edited = await modversion('edited', '1.0', { storedMd5: '0'.repeat(32) })
        const response = await actingAs(await admin()).post('/solder/repository/fix', { modversions: [edited.id] })
        expect(redirectPath(response)).toBe(new URL(route('solder.repository')).pathname)
        expect(flashed(response).success).toBe('Updated the stored checksum of 1 mod version.')
        expect((await db.modversion.findUniqueOrThrow({ where: { id: edited.id } })).md5).toBe(md5File(`${repository.path()}mods/edited/edited-1.0.zip`))
        expect(await runCheck()).toEqual({})
    })

    it('explains when no check has run', async () => {
        expectSee(await actingAs(await admin()).get('/solder/repository').expect(200), 'No check has been run yet')
    })

    it('needs permission to manage mods', async () => {
        const viewer = await makeUser()
        expect(redirectPath(await actingAs(viewer).get('/solder/repository'))).toBe('/dashboard')
        expect(redirectPath(await actingAs(viewer).post('/solder/repository'))).toBe('/dashboard')
        expect(redirectPath(await actingAs(viewer).post('/solder/repository/fix', { modversions: [1] }))).toBe('/dashboard')
    })
})

describe('Uploading mods', () => {
    useSolder()
    const repository = useModRepository()

    const iris = (version = '1.7.0') =>
        makeArchive({
            'fabric.mod.json': JSON.stringify({
                id: 'iris',
                name: 'Iris',
                version,
                description: 'Shaders',
                authors: ['coderbot', { name: 'IMS' }],
                contact: { homepage: 'https://irisshaders.dev' },
                depends: { minecraft: '~1.20.1', sodium: '*' },
            }),
        })

    async function upload(url: string, files: [string, string | Buffer][], fields: Record<string, string> = {}, user?: { id: number }) {
        let test = actingAs(user ?? (await admin())).upload(url)
        for (const [name, value] of Object.entries(fields)) {
            test = test.field(name, value)
        }
        for (const [name, contents] of files) {
            test = test.attach('files[]', Buffer.from(contents), name)
        }
        return test
    }

    const zipEntries = (mod: string, version: string) => ZipReader.open(`${repository.path()}mods/${mod}/${mod}-${version}.zip`)!.names()
    const errorList = (response: Parameters<typeof flashedErrors>[0]) => Object.values(flashedErrors(response)).flat()
    const versionsOf = async (modId: number) => (await db.modversion.findMany({ where: { mod_id: modId }, orderBy: { id: 'asc' } })).map((mv) => mv.version)

    it('fits long jar metadata into the mods table', async () => {
        const authors = Array.from({ length: 60 }, (_, i) => `Contributor${i}`)
        const jar = makeArchive({
            'fabric.mod.json': JSON.stringify({
                id: 'crowded',
                name: 'Crowded '.repeat(40).trim(),
                version: '1.0.0',
                authors,
                contact: { homepage: `https://example.com/${'a'.repeat(300)}` },
                depends: { minecraft: '1.20.1' },
            }),
        })

        await upload('/mod/upload', [['crowded-1.0.0.jar', jar]])

        const mod = await db.mod.findUniqueOrThrow({ where: { name: 'crowded' } })
        expect(mod.author).toHaveLength(255)
        expect(mod.author!.startsWith('Contributor0, Contributor1, ')).toBe(true)
        expect(mod.author!.endsWith('...')).toBe(true)
        expect(mod.pretty_name!.length).toBeLessThanOrEqual(255)
        expect(mod.link).toBeNull()
    })

    it('creates mods from the metadata of uploaded jars', async () => {
        const response = await upload('/mod/upload', [['iris-1.7.0.jar', iris()]])
        const mod = await db.mod.findUniqueOrThrow({ where: { name: 'iris' } })
        expect(redirectPath(response)).toBe(`/mod/view/${mod.id}`)
        expect(flashed(response).success).toBe('Added Iris 1.20.1-1.7.0.')
        expect(mod).toMatchObject({ pretty_name: 'Iris', author: 'coderbot, IMS', link: 'https://irisshaders.dev' })

        const [modversion] = await db.modversion.findMany({ where: { mod_id: mod.id } })
        expect(modversion.version).toBe('1.20.1-1.7.0')
        expect(zipEntries('iris', '1.20.1-1.7.0')).toEqual(['mods/iris-1.7.0.jar'])
        expect(modversion.md5).toBe(md5File(`${repository.path()}mods/iris/iris-1.20.1-1.7.0.zip`))
    })

    it('reports on each of several uploaded jars', async () => {
        const response = await upload('/mod/upload', [
            ['iris.jar', iris()],
            ['broken.jar', 'not a zip'],
            ['notes.txt', 'hello'],
        ])
        // Only one mod was added, so the response opens it
        expect(redirectPath(response)).toBe(`/mod/view/${(await db.mod.findUniqueOrThrow({ where: { name: 'iris' } })).id}`)
        expect(flashed(response).success).toBe('Added Iris 1.20.1-1.7.0.')
        expect(errorList(response)).toContain('broken.jar: not a valid jar or zip file')
        expect(errorList(response)).toContain('notes.txt: only .jar and .zip files can be uploaded')
    })

    it('uploads versions to an existing mod', async () => {
        const mod = await db.mod.create({ data: { name: 'iris', pretty_name: 'Iris' } })
        const first = await upload(`/mod/upload/${mod.id}`, [['iris.jar', iris('1.8.0')]])
        expect(first.headers.location).toMatch(new RegExp(`/mod/view/${mod.id}#versions$`))
        await upload(`/mod/upload/${mod.id}`, [['iris-pack.zip', makeArchive({ 'mods/iris.jar': 'jar', 'config/iris.properties': 'x' })]], { version: 'custom 2' })
        expect(await versionsOf(mod.id)).toEqual(['1.20.1-1.8.0', 'custom-2'])
        expect(zipEntries('iris', 'custom-2')).toEqual(['mods/iris.jar', 'config/iris.properties'])
    })

    it('offers uploads on the mod page and shows where versions came from', async () => {
        const mod = await db.mod.create({ data: { name: 'iris', pretty_name: 'Iris' } })
        await db.modversion.create({ data: { mod_id: mod.id, version: '1.7.0', md5: 'x', provider: 'modrinth', provider_project_id: 'YL57xq9U', provider_version_id: 'v1' } })
        const response = await actingAs(await admin()).get(`/mod/view/${mod.id}`).expect(200)
        expect(response.text).toContain(`${new URL(route('mod.upload_versions', { mod_id: mod.id })).pathname}"`)
        // js() escapes quotes in the row data it embeds
        expect(response.text).toContain('\\u0022provider\\u0022:\\u0022Modrinth\\u0022')
    })

    it('does not overwrite existing versions', async () => {
        const mod = await db.mod.create({ data: { name: 'iris', pretty_name: 'Iris' } })
        await db.modversion.create({ data: { mod_id: mod.id, version: '1.20.1-1.7.0', md5: 'original' } })
        const response = await upload(`/mod/upload/${mod.id}`, [['iris.jar', iris()]])
        expect(errorList(response)).toEqual(['iris.jar: iris 1.20.1-1.7.0 already exists'])
        expect((await db.modversion.findMany({ where: { mod_id: mod.id } })).map((mv) => mv.md5)).toEqual(['original'])
        expect(flashed(response)).not.toHaveProperty('success')
    })

    it('needs a local repository', async () => {
        config.solder.repo_location = 'https://mods.example.com/'
        const response = await upload('/mod/upload', [['iris.jar', iris()]])
        expect(errorList(response)[0]).toContain('remote URL')
        expect(await db.mod.count({ where: { name: 'iris' } })).toBe(0)
    })

    it('needs permission', async () => {
        const response = await upload('/mod/upload', [['iris.jar', iris()]], {}, await makeUser())
        expect(redirectPath(response)).toBe('/dashboard')
        expect(await db.mod.count({ where: { name: 'iris' } })).toBe(0)
    })
})
