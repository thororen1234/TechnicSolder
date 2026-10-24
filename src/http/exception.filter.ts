import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common'
import type { Request, Response } from 'express'
import { config, isTesting } from '../config.js'
import { AuthorizationError } from '../policies/gate.js'
import { logger } from '../support/logger.js'
import { render } from '../views/view.js'
import { HttpError, UnauthenticatedError, ValidationError } from './errors.js'
import { AlreadyAuthenticatedError } from './guards.js'
import { isApiRequest } from './middleware.js'
import { Web } from './web.js'

interface RouteLayer {
    route?: { path: string; methods: Record<string, boolean> }
    matcher?: (path: string) => unknown
    match?: (path: string) => boolean
}

let routes: { matches: (path: string) => boolean; methods: string[] }[] = []

/** Remember the app's routes, to tell a wrong method (405) from a missing route (404) */
export function registerRoutes(instance: unknown): void {
    // Express 5 keeps the router on .router, Express 4 on ._router
    const express = instance as { router?: { stack: RouteLayer[] }; _router?: { stack: RouteLayer[] } }
    const stack = express.router?.stack ?? express._router?.stack ?? []
    routes = stack
        .filter((layer) => layer.route !== undefined)
        .map((layer) => ({
            matches: (path: string) => (typeof layer.match === 'function' ? layer.match(path) : false),
            methods: Object.keys(layer.route!.methods).map((method) => method.toUpperCase()),
        }))
}

function allowedMethods(path: string): string[] {
    return [...new Set(routes.filter((route) => route.matches(path)).flatMap((route) => route.methods))]
}

const STATUS_TEXT: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    419: 'Page Expired',
    429: 'Too Many Requests',
    500: 'Server Error',
    503: 'Service Unavailable',
}

/**
 * Turns errors into responses the way Laravel's exception handler did: JSON for the API and for requests that
 * expect JSON, otherwise a redirect (sign in, missing permission, failed validation) or an error page.
 */
@Catch()
export class SolderExceptionFilter implements ExceptionFilter {
    async catch(exception: unknown, host: ArgumentsHost): Promise<void> {
        const req = host.switchToHttp().getRequest<Request>()
        const res = host.switchToHttp().getResponse<Response>()
        if (res.headersSent) {
            return
        }
        const web = Web.of(req, res)
        const wantsJson = isApiRequest(req) || web.expectsJson()

        if (exception instanceof UnauthenticatedError) {
            if (wantsJson) {
                res.status(401).json({ message: 'Unauthenticated.' })
                return
            }
            if (req.method === 'GET' && req.session) {
                req.session.intended = req.originalUrl
            }
            web.redirect('login').send()
            return
        }

        if (exception instanceof AlreadyAuthenticatedError) {
            web.redirect('dashboard').send()
            return
        }

        if (exception instanceof AuthorizationError) {
            if (wantsJson) {
                res.status(403).json({ message: exception.message })
                return
            }
            web.redirect('dashboard').with('permission', 'You do not have permission to access this area.').send()
            return
        }

        if (exception instanceof ValidationError) {
            if (wantsJson) {
                res.status(422).json({ message: exception.message, errors: exception.errors })
                return
            }
            const redirect = exception.redirectTo ? web.redirect(exception.redirectTo) : web.back()
            redirect.withErrors(exception.errors).withInput().send()
            return
        }

        let status = 500
        let message = ''
        let headers: Record<string, string> = {}
        if (exception instanceof HttpError) {
            status = exception.status
            message = exception.message
            headers = exception.headers
        } else if (exception instanceof HttpException) {
            status = exception.getStatus()
            message = status === 404 ? '' : exception.message
            // A path that exists for other methods is "Method Not Allowed", as Laravel answered
            const allowed = status === 404 ? allowedMethods(req.path) : []
            if (allowed.length > 0) {
                status = 405
                headers = { Allow: allowed.join(', ') }
                message = `The ${req.method} method is not supported for route ${req.path.replace(/^\//, '')}. Supported methods: ${allowed.join(', ')}.`
            }
        } else {
            logger.report(exception)
            message = (config.app.debug || isTesting()) && exception instanceof Error ? exception.message : ''
        }
        for (const [name, value] of Object.entries(headers)) {
            res.setHeader(name, value)
        }

        if (wantsJson) {
            const fallback = status === 404 && isApiRequest(req) ? `The route ${req.path.replace(/^\//, '')} could not be found.` : (STATUS_TEXT[status] ?? 'Server Error')
            res.status(status).json({ message: message || (status >= 500 ? 'Server Error' : fallback) })
            return
        }

        const view = join(config.paths.views, 'errors', `${status}.eta`)
        if (existsSync(view)) {
            try {
                const html = await render(`errors.${status}`, { exception: { message } }, {
                    user: null,
                    csrfToken: '',
                    flash: {},
                    errors: {},
                    oldInput: {},
                })
                res.status(status).type('html').send(html)
                return
            } catch (renderError) {
                logger.report(renderError)
            }
        }
        res.status(status).type('text').send(message || STATUS_TEXT[status] || 'Error')
    }
}
