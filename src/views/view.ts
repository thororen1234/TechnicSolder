import { Eta } from 'eta'
import { config, isProduction, SOLDER_VERSION } from '../config.js'
import { appUrl, route } from '../http/urls.js'
import { JAVA_RUNTIME_LABELS, JAVA_VERSIONS } from '../models/java.js'
import { CANCELLED, COMPLETED, FAILED, QUEUED, RUNNING, WAITING, WAITING_DAYS } from '../models/modpack-import.js'
import type { ModpackImport, Modpack, UserWithPermission } from '../models/types.js'
import { providers } from '../mods/mod-providers.js'
import { Policies, allows } from '../policies/gate.js'
import { isConfigured as discordConfigured } from '../services/discord-notifier.js'
import { ModRepository } from '../services/mod-repository.js'
import { FORMATS } from '../services/pack-export.js'
import { Carbon, carbon } from './carbon.js'
import { ErrorBag, php, toViewData } from './helpers.js'

let eta: Eta | null = null

function engine(): Eta {
    eta ??= new Eta({
        views: config.paths.views,
        useWith: true,
        autoTrim: false,
        cache: isProduction(),
        defaultExtension: '.eta',
    })
    return eta
}

/** What a view needs to know about the request that renders it */
export interface ViewRequest {
    user: UserWithPermission | null
    csrfToken: string
    /** Flashed session data from the previous request (success, status, permission, newToken...) */
    flash: Record<string, unknown>
    errors: Record<string, string[]>
    oldInput: Record<string, unknown>
    /** Shared layout data (the modpack rail, update banner) */
    layout?: Record<string, unknown>
    /** URL::previous() */
    previousUrl?: string
    /** request($key): the request's input */
    input?: Record<string, unknown>
    /** URL::current(): this request's URL without the query string */
    currentUrl?: string
}

type Ability =
    | 'grant-permission'
    | 'create'
    | 'update'
    | 'delete'
    | 'view'

/** @can() in templates, for the abilities the views check */
function canFor(user: UserWithPermission | null) {
    return (ability: Ability, subject?: unknown): boolean => {
        if (user === null) {
            return false
        }
        if (ability === 'grant-permission') {
            return allows(user, Policies.grantPermission(String(subject)))
        }
        if (subject === 'modpack' && ability === 'create') {
            return allows(user, Policies.modpack.create())
        }
        // An import passed with its modpack loaded (modpackImport.modpack)
        if (subject !== null && typeof subject === 'object' && 'status' in subject && 'source' in subject) {
            const modpackImport = subject as ModpackImport & { modpack?: Modpack | null }
            return allows(user, ability === 'update' ? Policies.modpackImport.update(modpackImport.modpack ?? null) : Policies.modpackImport.view(modpackImport, modpackImport.modpack ?? null))
        }
        throw new Error(`@can('${ability}') is not supported for this subject`)
    }
}

function oldFor(oldInput: Record<string, unknown>) {
    return (key: string, fallback: unknown = null): unknown => {
        let value: unknown = oldInput
        for (const segment of key.split('.')) {
            value = value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[segment] : undefined
        }
        return value === undefined ? fallback : value
    }
}

export function viewGlobals(request: ViewRequest): Record<string, unknown> {
    const user = request.user
    const errors = new ErrorBag(request.errors)
    return {
        ...php,
        url: appUrl,
        asset: appUrl,
        route,
        config: (key: string, fallback: unknown = null) => {
            let value: unknown = config
            for (const segment of key.split('.')) {
                value = value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[segment] : undefined
            }
            return value ?? fallback
        },
        csrfToken: () => request.csrfToken,
        csrf_token: () => request.csrfToken,
        csrfField: () => `<input type="hidden" name="_token" value="${request.csrfToken}" autocomplete="off">`,
        session: (key: string, fallback: unknown = null) => request.flash[key] ?? fallback,
        old: oldFor(request.oldInput),
        errors,
        can: canFor(user),
        authUser: user,
        authId: user?.id ?? null,
        now: () => new Carbon(),
        carbon,
        carbonFromTimestamp: (seconds: number) => carbon(seconds * 1000),
        SOLDER_VERSION,
        explode: (separator: string, value: unknown, limit?: number) => {
            const parts = String(value ?? '').split(separator)
            return limit === undefined || parts.length <= limit ? parts : [...parts.slice(0, limit - 1), parts.slice(limit - 1).join(separator)]
        },
        previousUrl: () => request.previousUrl ?? appUrl('/'),
        currentUrl: () => request.currentUrl ?? appUrl('/'),
        request: (key: string, fallback: unknown = null) => request.input?.[key] ?? fallback,
        cacheHas: (key: string) => key === 'update' && Boolean(request.layout?.updateAvailable),
        discord: { isConfigured: discordConfigured, hasWebhook: () => Boolean(config.solder.discord_webhook), sendsDirectMessages: () => Boolean(config.solder.discord_bot_token && config.solder.discord_user_id) },
        ModpackImport: { QUEUED, RUNNING, WAITING, COMPLETED, FAILED, CANCELLED, WAITING_DAYS },
        providers,
        exportFormats: FORMATS,
        repositoryLocation: (modversion: { version: string; mod: { name: string } }) => ModRepository.location(modversion),
        javaVersions: JAVA_VERSIONS.map((value) => ({ value })),
        javaRuntimes: Object.entries(JAVA_RUNTIME_LABELS).map(([value, label]) => ({ value, label: () => label })),
        javaRuntimeFrom: (value: string) => ({ value, label: () => JAVA_RUNTIME_LABELS[value as keyof typeof JAVA_RUNTIME_LABELS] ?? value }),
        ...(toViewData(request.layout ?? {}) as Record<string, unknown>),
    }
}

/**
 * Render a template from resources/views. `name` uses Blade's dot notation ("modpack.view") or a path.
 */
export async function render(name: string, data: Record<string, unknown>, request: ViewRequest): Promise<string> {
    const path = `/${name.replace(/\./g, '/')}`
    const viewData = toViewData(data) as Record<string, unknown>
    return engine().renderAsync(path, { ...viewGlobals(request), ...viewData })
}
