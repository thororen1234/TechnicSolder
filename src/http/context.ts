import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Who is making the current request, available anywhere during it (Laravel's Auth::id()).
 */
interface RequestContext {
    /** The user signed in to the web interface, or authenticated by an API token */
    userId: number | null
    /** Scheme and host the request came in on, for building URLs */
    baseUrl?: string
}

const storage = new AsyncLocalStorage<RequestContext>()

export function runWithContext<T>(context: RequestContext, callback: () => T): T {
    return storage.run(context, callback)
}

export function currentContext(): RequestContext | undefined {
    return storage.getStore()
}

export function setCurrentUserId(userId: number | null): void {
    const context = storage.getStore()
    if (context) {
        context.userId = userId
    }
}

export function currentUserId(): number | null {
    return storage.getStore()?.userId ?? null
}
