/**
 * Errors that turn into specific responses (see ExceptionFilter), like Laravel's abort() and auth exceptions.
 */
export class HttpError extends Error {
    constructor(
        public readonly status: number,
        message = '',
        public readonly headers: Record<string, string> = {},
    ) {
        super(message)
    }
}

/** abort($status, $message) */
export function abort(status: number, message = ''): never {
    throw new HttpError(status, message)
}

/** Not signed in: a redirect to the login page, or 401 for the API */
export class UnauthenticatedError extends Error {
    constructor() {
        super('Unauthenticated.')
    }
}

/** The CSRF token didn't match (Laravel's 419 "Page Expired") */
export class TokenMismatchError extends HttpError {
    constructor() {
        super(419, 'CSRF token mismatch.')
    }
}

export class TooManyRequestsError extends HttpError {
    constructor(retryAfter: number) {
        super(429, 'Too Many Attempts.', { 'Retry-After': String(retryAfter) })
    }
}

/** A failed form submission that should go back with errors and input (Laravel's ValidationException) */
export class ValidationError extends Error {
    constructor(
        public readonly errors: Record<string, string[]>,
        public readonly redirectTo: string | null = null,
    ) {
        super(Object.values(errors).flat()[0] ?? 'The given data was invalid.')
    }
}
