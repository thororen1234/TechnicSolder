import { createHash } from 'node:crypto'
import { config } from '../config.js'
import { logger } from '../support/logger.js'
import { ConnectionError, request } from '../support/http.js'

const USER_AGENT = 'Mozilla/5.0 TechnicSolder/0.7 (+https://github.com/TechnicPack/TechnicSolder)'

export type RemoteMd5Result = { success: true; md5: string; filesize: number } | { success: false; message: string }

/** Connection errors explained in terms of Solder's settings, as the cURL error hints did */
function connectionHint(code: string | undefined): string {
    switch (code) {
        case 'ENOTFOUND':
        case 'EAI_AGAIN':
            return 'Could not resolve hostname. Verify that SOLDER_REPO_LOCATION points to a valid domain.'
        case 'ECONNREFUSED':
            return 'Connection refused by the remote server. Ensure it is running and accessible from the Solder host.'
        case 'ETIMEDOUT':
        case 'UND_ERR_CONNECT_TIMEOUT':
            return 'Connection timed out. Consider increasing SOLDER_MD5_CONNECT_TIMEOUT or SOLDER_MD5_FILE_TIMEOUT.'
        default:
            return `Network error (${code ?? 'unknown'}). Check connectivity to the remote server.`
    }
}

/** Download a URL and hash it as it streams in */
export async function remoteMd5(url: string): Promise<RemoteMd5Result> {
    try {
        const response = await request(url, {
            headers: { 'User-Agent': USER_AGENT },
            timeout: config.solder.md5_file_timeout || 15,
        })
        if (response.status !== 200) {
            await response.buffer().catch(() => null)
            return { success: false, message: `Expected status code 200, got ${response.status}` }
        }
        const hash = createHash('md5')
        let filesize = 0
        for await (const chunk of response.stream()) {
            filesize += (chunk as Buffer).length
            hash.update(chunk as Buffer)
        }
        return { success: true, md5: hash.digest('hex'), filesize }
    } catch (error) {
        if (error instanceof ConnectionError) {
            logger.warn(`Remote MD5 failed for ${url}: ${error.message}`)
            return { success: false, message: connectionHint(error.code) }
        }
        logger.error(`Error hashing remote md5: ${(error as Error).message}`)
        return { success: false, message: (error as Error).message }
    }
}
