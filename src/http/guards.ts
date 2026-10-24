import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common'
import type { Request } from 'express'
import { UnauthenticatedError } from './errors.js'

/** Routes for signed-in users (the web session, or a bearer token on the API) */
@Injectable()
export class AuthGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        const req = context.switchToHttp().getRequest<Request>()
        if (!req.user) {
            throw new UnauthenticatedError()
        }
        return true
    }
}

/** Thrown by GuestGuard: someone signed in opened the login page */
export class AlreadyAuthenticatedError extends Error {}

/** Routes for visitors who aren't signed in (login, password reset) */
@Injectable()
export class GuestGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        const req = context.switchToHttp().getRequest<Request>()
        if (req.user) {
            throw new AlreadyAuthenticatedError()
        }
        return true
    }
}
