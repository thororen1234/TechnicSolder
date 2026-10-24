import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'

/**
 * Outgoing HTTP requests (mod providers, GitHub, Discord, remote mod repositories), with Laravel-style faking
 * for tests: Http.fake({'api.modrinth.com/*': {body: {...}}}) answers matching requests without the network.
 */
export interface HttpResponse {
    status: number
    ok: boolean
    headers: Headers
    text(): Promise<string>
    json<T = unknown>(): Promise<T>
    buffer(): Promise<Buffer>
    /** The body as a stream, for large downloads */
    stream(): Readable
}

export interface RequestOptions {
    method?: string
    headers?: Record<string, string>
    /** Sent as JSON */
    json?: unknown
    body?: string | Buffer
    /** Total timeout in seconds */
    timeout?: number
    /** Extra attempts after a connection failure or 5xx response */
    retries?: number
    retryDelayMs?: number
}

export interface FakeResponse {
    status?: number
    body?: string | Buffer | object | null
    headers?: Record<string, string>
}

type FakeHandler = FakeResponse | ((request: RecordedRequest) => FakeResponse | Promise<FakeResponse>)

export interface RecordedRequest {
    url: string
    method: string
    headers: Record<string, string>
    body: string | null
}

/** Thrown when a server can't be reached */
export class ConnectionError extends Error {
    constructor(
        message: string,
        /** The underlying error code, such as ENOTFOUND or ECONNREFUSED */
        public readonly code: string | undefined,
    ) {
        super(message)
    }
}

let fakes: [string, FakeHandler][] | null = null
let recorded: RecordedRequest[] = []
let preventStray = false

/** Str::is with a "*" wildcard */
function matches(pattern: string, url: string): boolean {
    const regex = new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
    return regex.test(url)
}

function fakeBody(body: FakeResponse['body']): Buffer {
    if (body === null || body === undefined) {
        return Buffer.alloc(0)
    }
    if (Buffer.isBuffer(body)) {
        return body
    }
    return Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
}

function toResponse(status: number, headers: Headers, bytes: () => Promise<Buffer>, stream: () => Readable): HttpResponse {
    let cached: Promise<Buffer> | null = null
    const buffer = () => (cached ??= bytes())
    return {
        status,
        ok: status >= 200 && status < 300,
        headers,
        buffer,
        text: async () => (await buffer()).toString('utf8'),
        json: async <T>() => JSON.parse((await buffer()).toString('utf8')) as T,
        stream,
    }
}

async function fakeResponse(request: RecordedRequest): Promise<HttpResponse | null> {
    if (fakes === null) {
        return null
    }
    for (const [pattern, handler] of fakes) {
        if (matches(pattern.startsWith('*') ? pattern : `*${pattern}`, request.url)) {
            const response = typeof handler === 'function' ? await handler(request) : handler
            const body = fakeBody(response.body)
            const headers = new Headers(response.headers ?? {})
            return toResponse(response.status ?? 200, headers, async () => body, () => Readable.from([body]))
        }
    }
    if (preventStray) {
        throw new Error(`Attempted request to [${request.url}] without a matching fake.`)
    }
    return null
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function request(url: string, options: RequestOptions = {}): Promise<HttpResponse> {
    const method = options.method ?? (options.json !== undefined || options.body !== undefined ? 'POST' : 'GET')
    const headers: Record<string, string> = { ...(options.headers ?? {}) }
    let body: string | Buffer | undefined = options.body
    if (options.json !== undefined) {
        body = JSON.stringify(options.json)
        headers['Content-Type'] ??= 'application/json'
        headers['Accept'] ??= 'application/json'
    }
    const record: RecordedRequest = { url, method, headers, body: body === undefined ? null : body.toString() }
    recorded.push(record)

    const retries = options.retries ?? 0
    for (let attempt = 0; ; attempt++) {
        try {
            const faked = await fakeResponse(record)
            if (faked) {
                if (faked.status >= 500 && attempt < retries) {
                    await sleep(options.retryDelayMs ?? 0)
                    continue
                }
                return faked
            }
            const response = await fetch(url, {
                method,
                headers,
                body: Buffer.isBuffer(body) ? new Uint8Array(body) : body,
                redirect: 'follow',
                signal: AbortSignal.timeout((options.timeout ?? 30) * 1000),
            })
            if (response.status >= 500 && attempt < retries) {
                await response.body?.cancel()
                await sleep(options.retryDelayMs ?? 0)
                continue
            }
            return toResponse(
                response.status,
                response.headers,
                async () => Buffer.from(await response.arrayBuffer()),
                () => (response.body ? Readable.fromWeb(response.body as WebReadableStream) : Readable.from([])),
            )
        } catch (error) {
            if (attempt < retries) {
                await sleep(options.retryDelayMs ?? 0)
                continue
            }
            if (error instanceof ConnectionError || (error instanceof Error && error.message.startsWith('Attempted request to'))) {
                throw error
            }
            const cause = (error as { cause?: { code?: string; message?: string } }).cause
            const code = (error as Error).name === 'TimeoutError' ? 'ETIMEDOUT' : cause?.code
            throw new ConnectionError(cause?.message ?? (error as Error).message, code)
        }
    }
}

/** Stream a response body into a file */
export async function saveTo(response: HttpResponse, destination: string): Promise<void> {
    await pipeline(response.stream(), createWriteStream(destination))
}

export const Http = {
    /** Answer requests whose URL matches a pattern ("*" wildcards) with a fake response */
    fake(responses: Record<string, FakeHandler> = { '*': { status: 200, body: '' } }): void {
        fakes = [...(fakes ?? []), ...Object.entries(responses)]
    },
    /** Fail any request that has no fake */
    preventStrayRequests(): void {
        preventStray = true
        fakes ??= []
    },
    recorded(): RecordedRequest[] {
        return recorded
    },
    reset(): void {
        fakes = null
        recorded = []
        preventStray = false
    },
}
