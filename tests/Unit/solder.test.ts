import { Cache, HOUR } from '../../src/support/cache.js'
import { actingAs, admin, expectSee, useSolder } from '../support/helpers.js'

describe('Solder settings', () => {
    useSolder()

    it('shows the configure page', async () => {
        const response = await actingAs(await admin()).get('/solder/configure').expect(200)
        expectSee(response, 'Configure Solder')
    })

    it('shows the update page', async () => {
        // Pre-seed the cache so the update check doesn't hit GitHub
        await Cache.put(
            'update:github:changelog:main',
            [
                {
                    sha: 'abc123',
                    html_url: 'https://example.com',
                    commit: { message: 'test commit', author: { date: '2025-01-01T00:00:00Z', name: 'Test' } },
                    author: { avatar_url: 'https://example.com/avatar.png', login: 'test' },
                    committer: { avatar_url: 'https://example.com/avatar.png', login: 'test' },
                },
            ],
            HOUR,
        )
        await Cache.put('update:github:tags', [{ name: '0.0.1' }], HOUR)
        const response = await actingAs(await admin()).get('/solder/update').expect(200)
        expectSee(response, 'Update Manager')
    })

    it('shows a commit not linked to a GitHub user', async () => {
        await Cache.put(
            'update:github:changelog:main',
            [
                {
                    sha: 'def456',
                    html_url: 'https://example.com',
                    commit: { message: 'unlinked commit', author: { date: '2025-01-01T00:00:00Z', name: 'Unlinked Author' } },
                    author: null,
                    committer: null,
                },
            ],
            HOUR,
        )
        await Cache.put('update:github:tags', [{ name: '0.0.1' }], HOUR)
        const response = await actingAs(await admin()).get('/solder/update').expect(200)
        expectSee(response, 'unlinked commit')
    })
})
