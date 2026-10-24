import { remoteMd5 } from '../../src/services/url-utils.js'
import { ConnectionError, Http } from '../../src/support/http.js'

describe('remoteMd5', () => {
    beforeEach(() => Http.reset())

    it('hashes a remote file', async () => {
        Http.fake({ 'https://test.invalid/test': { body: 'test' } })
        expect(await remoteMd5('https://test.invalid/test')).toEqual({ success: true, md5: '098f6bcd4621d373cade4e832627b4f6', filesize: 4 })
    })

    it('reports responses other than 200', async () => {
        Http.fake({ 'https://test.invalid/404': { status: 404 } })
        expect(await remoteMd5('https://test.invalid/404')).toEqual({ success: false, message: 'Expected status code 200, got 404' })
    })

    it.each([
        ['dns resolution failure', 'ENOTFOUND', 'Could not resolve hostname. Verify that SOLDER_REPO_LOCATION points to a valid domain.'],
        ['connection refused', 'ECONNREFUSED', 'Connection refused by the remote server. Ensure it is running and accessible from the Solder host.'],
        ['connection timeout', 'ETIMEDOUT', 'Connection timed out. Consider increasing SOLDER_MD5_CONNECT_TIMEOUT or SOLDER_MD5_FILE_TIMEOUT.'],
        ['unknown network error', 'EWHATEVER', 'Network error (EWHATEVER). Check connectivity to the remote server.'],
    ])('explains a %s', async (_name, code, message) => {
        Http.fake({
            'https://test.invalid/test': () => {
                throw new ConnectionError(`connect ${code}`, code)
            },
        })
        expect(await remoteMd5('https://test.invalid/test')).toEqual({ success: false, message })
    })
})
