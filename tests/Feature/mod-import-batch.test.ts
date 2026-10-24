import { db } from '../../src/database/prisma.js'
import type { VersionData } from '../../src/mods/imported-mod-data.js'
import { latestStableVersionForGame } from '../../src/mods/mod-provider.js'
import { actingAs, admin, fakeFabricMeta, flashed, flashedErrors, useModRepository, useSolder } from '../support/helpers.js'

describe('Batch mod import', () => {
    useSolder()
    useModRepository()
    beforeEach(() => fakeFabricMeta())

    const importBatch = async (data: object) => actingAs(await admin()).post('/mod/import/batch', data)

    async function importedFabricVersions(): Promise<string[]> {
        const mod = await db.mod.findUnique({ where: { name: 'fabric-loader' } })
        return mod ? (await db.modversion.findMany({ where: { mod_id: mod.id } })).map((mv) => mv.version) : []
    }

    it('needs mods to be selected', async () => {
        expect(flashedErrors(await importBatch({ provider: 'fabric', game_version: '1.18.2' }))).toHaveProperty('no_mods')
    })

    it('needs a known provider', async () => {
        expect(flashedErrors(await importBatch({ provider: 'invalid_provider', mods: ['1.18.2'] }))).toHaveProperty('invalid_provider')
    })

    it('imports for a game version', async () => {
        const response = await importBatch({ provider: 'fabric', game_version: '1.18.2', release_type: 'release', mods: ['1.18.2'] })
        expect(flashedErrors(response)).toEqual({})
        expect(flashed(response).success).toBeTruthy()
    })

    it('imports without a game version', async () => {
        const response = await importBatch({ provider: 'fabric', game_version: '', release_type: 'any', mods: ['1.18.2'] })
        expect(flashedErrors(response)).toEqual({})
        expect(flashed(response).success).toBeTruthy()
        // The empty game_version must not reach the provider as one
        expect(await importedFabricVersions()).toEqual(['1.18.2-0.15.0'])
    })

    it('skips unstable loaders for releases', async () => {
        const response = await importBatch({ provider: 'fabric', game_version: '1.18.2', release_type: 'release', mods: ['1.18.2'] })
        expect(flashedErrors(response)).toEqual({})
        expect(await importedFabricVersions()).toEqual(['1.18.2-0.14.9'])
    })

    it('reports a game version that does not exist', async () => {
        const response = await importBatch({ provider: 'fabric', game_version: '9.99.99', release_type: 'release', mods: ['1.18.2'] })
        expect(Object.keys(flashedErrors(response)).length).toBeGreaterThan(0)
    })

    it('finds unstable Fabric loaders as betas', async () => {
        const response = await importBatch({ provider: 'fabric', game_version: '', release_type: 'beta', mods: ['1.18.2'] })
        expect(flashedErrors(response)).toEqual({})
        expect(await importedFabricVersions()).toEqual(['1.18.2-0.15.0'])
    })
})

describe('latestStableVersionForGame', () => {
    const versions = (list: Record<string, { gameVersions: string[]; versionType?: string }>) => new Map(Object.entries(list) as [string, VersionData][])
    const beta = { gameVersions: ['1.19.2'], versionType: 'beta' }
    const release = { gameVersions: ['1.19.2'], versionType: 'release' }

    it('returns null without versions', () => {
        expect(latestStableVersionForGame(new Map(), '1.19.2')).toBeNull()
    })

    it('returns null without a matching game version', () => {
        expect(latestStableVersionForGame(versions({ '1.0.0': { gameVersions: ['1.18.2'], versionType: 'release' } }), '1.19.2')).toBeNull()
    })

    it('prefers a release over a beta by default', () => {
        expect(latestStableVersionForGame(versions({ '2.0.0-beta': beta, '1.9.0': release }), '1.19.2')).toBe('1.9.0')
    })

    it('falls back to a beta by default', () => {
        expect(latestStableVersionForGame(versions({ '2.0.0-beta': beta }), '1.19.2')).toBe('2.0.0-beta')
    })

    it('returns the first release without a game filter', () => {
        const list = versions({ '3.0.0': { gameVersions: ['1.20.1'], versionType: 'release' }, '2.0.0': { gameVersions: ['1.19.2'], versionType: 'release' } })
        expect(latestStableVersionForGame(list, '')).toBe('3.0.0')
    })

    it('assumes a release when the type is missing', () => {
        expect(latestStableVersionForGame(versions({ '1.0.0': { gameVersions: ['1.19.2'] } }), '1.19.2')).toBe('1.0.0')
    })

    it('excludes betas for the release type', () => {
        expect(latestStableVersionForGame(versions({ '2.0.0-beta': beta, '1.9.0': release }), '1.19.2', 'release')).toBe('1.9.0')
    })

    it('returns null for the release type without a release', () => {
        expect(latestStableVersionForGame(versions({ '2.0.0-beta': beta }), '1.19.2', 'release')).toBeNull()
    })

    it('returns a beta for the beta type', () => {
        expect(latestStableVersionForGame(versions({ '2.0.0-beta': beta, '1.9.0': release }), '1.19.2', 'beta')).toBe('2.0.0-beta')
    })

    it('returns the first version for any type', () => {
        expect(latestStableVersionForGame(versions({ '2.0.0-beta': beta, '1.9.0': release }), '1.19.2', 'any')).toBe('2.0.0-beta')
    })

    it('returns null for the alpha type without an alpha', () => {
        expect(latestStableVersionForGame(versions({ '1.9.0': release }), '1.19.2', 'alpha')).toBeNull()
    })
})
