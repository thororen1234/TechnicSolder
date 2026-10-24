import { SOLDER_VERSION } from '../config.js'
import { Cache, HOUR } from '../support/cache.js'
import { request } from '../support/http.js'
import { versionCompare } from '../support/version-compare.js'

/**
 * Release and changelog information for Solder itself, from the GitHub API.
 */
export interface GithubTag {
    name: string
    commit: { sha: string; url: string }
    [key: string]: unknown
}

export interface GithubCommit {
    sha: string
    html_url: string
    commit: { message: string; author: { name: string; date: string } }
    author: { login: string; avatar_url: string; html_url: string } | null
    [key: string]: unknown
}

export type GithubError = { error: string }

const REPOSITORY = 'https://api.github.com/repos/technicpack/technicsolder'

async function github<T>(path: string): Promise<T> {
    const response = await request(`${REPOSITORY}${path}`, {
        headers: { Accept: 'application/vnd.github.v3+json', 'User-Agent': `TechnicSolder/${SOLDER_VERSION}` },
        timeout: 15,
    })
    if (!response.ok) {
        let message = `HTTP ${response.status}`
        try {
            message = (await response.json<{ message?: string }>()).message ?? message
        } catch {
            // Not JSON
        }
        throw new Error(message)
    }
    return response.json<T>()
}

export function isGithubError(value: unknown): value is GithubError {
    return value !== null && typeof value === 'object' && !Array.isArray(value) && 'error' in value
}

export async function getAllVersions(): Promise<GithubTag[] | GithubError> {
    try {
        return await Cache.remember('update:github:tags', HOUR, () => github<GithubTag[]>('/tags'))
    } catch (error) {
        return { error: `Unable to fetch versions from Github: ${(error as Error).message}` }
    }
}

export async function getLatestVersion(): Promise<GithubTag | GithubError> {
    const versions = await getAllVersions()
    if (isGithubError(versions)) {
        return versions
    }
    return versions[0] ?? { error: 'Unable to fetch versions from Github: no releases found' }
}

/** Whether a newer Solder release than this one exists */
export async function getUpdateCheck(forceRefresh = false): Promise<boolean> {
    if (forceRefresh) {
        await Cache.forget('update:github:tags')
    }
    const latest = await getLatestVersion()
    return !isGithubError(latest) && versionCompare(latest.name, SOLDER_VERSION, '>')
}

export async function getLatestChangeLog(branch = 'main'): Promise<GithubCommit[] | GithubError> {
    try {
        return await Cache.remember(`update:github:changelog:${branch}`, HOUR, () =>
            github<GithubCommit[]>(`/commits?sha=${encodeURIComponent(branch)}`),
        )
    } catch (error) {
        return { error: `Unable to fetch changelog from Github: ${(error as Error).message}` }
    }
}
