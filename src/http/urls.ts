import { config } from '../config.js'
import { currentContext } from './context.js'

/**
 * URLs, like Laravel's url(), asset() and route(). During a request they use the host the request came in on;
 * in the queue worker and scheduler, APP_URL.
 */
function root(): string {
    return (currentContext()?.baseUrl ?? config.app.url).replace(/\/+$/, '')
}

/** url($path) / asset($path) */
export function appUrl(path = ''): string {
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(path)) {
        return path
    }
    // Like Laravel's url(), slashes around the path are dropped (but not those in a query string or fragment)
    const [, pathPart, rest] = /^([^?#]*)(.*)$/s.exec(path) as RegExpExecArray
    const trimmed = pathPart.replace(/^\/+|\/+$/g, '')
    return (trimmed === '' ? root() : `${root()}/${trimmed}`) + rest
}

type Params = Record<string, string | number | null | undefined> | string | number

/** Named routes, with {placeholders} filled from params */
const ROUTES: Record<string, string> = {
    'login': 'login',
    'logout': 'logout',
    'two-factor.login': 'two-factor-challenge',
    'password.request': 'forgot-password',
    'password.email': 'forgot-password',
    'password.reset': 'reset-password/{token}',
    'password.update': 'reset-password',
    'password.confirm': 'user/confirm-password',
    'password.confirmation': 'user/confirmed-password-status',
    'two-factor.enable': 'user/two-factor-authentication',
    'two-factor.confirm': 'user/confirmed-two-factor-authentication',
    'two-factor.disable': 'user/two-factor-authentication',
    'two-factor.qr-code': 'user/two-factor-qr-code',
    'two-factor.secret-key': 'user/two-factor-secret-key',
    'two-factor.recovery-codes': 'user/two-factor-recovery-codes',
    'two-factor.regenerate-recovery-codes': 'user/two-factor-recovery-codes',
    'client.list': 'client/list',
    'client.create': 'client/create',
    'client.delete': 'client/delete/{client_id}',
    'dashboard': 'dashboard',
    'dashboard.check_updates': 'dashboard/check-updates',
    'task.show': 'task/{taskId}',
    'task.status': 'task/{taskId}/status',
    'task.download': 'task/{taskId}/download',
    'key.list': 'key/list',
    'key.create': 'key/create',
    'key.delete': 'key/delete/{key_id}',
    'mod.list': 'mod/list',
    'mod.view': 'mod/view/{mod_id}',
    'mod.create': 'mod/create',
    'mod.import': 'mod/import',
    'mod.import_batch': 'mod/import/batch',
    'mod.upload': 'mod/upload',
    'mod.version_environment': 'mod/version-environment/{version_id}',
    'mod.unused': 'mod/unused',
    'mod.upload_versions': 'mod/upload/{mod_id}',
    'mod.import_details': 'mod/import/details/{provider}/{mod_id}',
    'mod.delete': 'mod/delete/{mod_id}',
    'modpack.list': 'modpack/list',
    'modpack.view': 'modpack/view/{modpack_id}',
    'modpack.build': 'modpack/build/{build_id}',
    'modpack.build.export': 'modpack/build/{build_id}/export',
    'modpack.build.export.archive': 'modpack/build/{build_id}/export/{format}',
    'modpack.build.copy': 'modpack/build/{build_id}/copy',
    'modpack.build.compare': 'modpack/build/{build_id}/compare',
    'modpack.build.health': 'modpack/build/{build_id}/health',
    'modpack.build.updates': 'modpack/build/{build_id}/updates',
    'modpack.export': 'modpack/export/{modpack_id}',
    'modpack.build.edit': 'modpack/build/{build_id}/edit',
    'modpack.build.delete': 'modpack/build/{build_id}/delete',
    'modpack.addBuild': 'modpack/add-build/{modpack_id}',
    'modpack.clone': 'modpack/clone/{modpack_id}',
    'modpack.import': 'modpack/import',
    'modpack.import.show': 'modpack/imports/{import_id}',
    'modpack.create': 'modpack/create',
    'modpack.edit': 'modpack/edit/{modpack_id}',
    'modpack.delete': 'modpack/delete/{modpack_id}',
    'solder.configure': 'solder/configure',
    'solder.update': 'solder/update',
    'solder.activity': 'solder/activity',
    'solder.notifications.test': 'solder/notifications/test',
    'solder.repository': 'solder/repository',
    'solder.repository.fix': 'solder/repository/fix',
    'solder.updateCheck': 'solder/update-check',
    'solder.cacheMinecraft': 'solder/cache-minecraft',
    'user.list': 'user/list',
    'user.edit': 'user/edit/{user_id}',
    'user.create': 'user/create',
    'user.reset2fa': 'user/{user_id}/reset-2fa',
    'user.delete': 'user/delete/{user_id}',
    'user.token.create': 'user/token/create',
    'user.token.delete': 'user/token/delete/{tokenId}',
}

/**
 * route($name, $params): a positional value fills the first placeholder; named values fill placeholders, and
 * the rest become the query string.
 */
export function route(name: string, params: Params = {}): string {
    const pattern = ROUTES[name]
    if (pattern === undefined) {
        throw new Error(`Route [${name}] not defined.`)
    }
    const named: Record<string, string | number | null | undefined> = typeof params === 'object' ? { ...params } : {}
    let positional = typeof params === 'object' ? undefined : params
    const path = pattern.replace(/\{(\w+)\}/g, (_match, key: string) => {
        if (named[key] !== undefined && named[key] !== null) {
            const value = named[key]
            delete named[key]
            return encodeURIComponent(String(value))
        }
        if (positional !== undefined) {
            const value = positional
            positional = undefined
            return encodeURIComponent(String(value))
        }
        throw new Error(`Missing parameter [${key}] for route [${name}].`)
    })
    const query = new URLSearchParams(
        Object.entries(named)
            .filter(([, value]) => value !== null && value !== undefined && value !== '')
            .map(([key, value]) => [key, String(value)]),
    ).toString()
    return appUrl(path) + (query ? `?${query}` : '')
}
