import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import dotenv from 'dotenv'

export const SOLDER_STREAM = 'rolling'
export const SOLDER_VERSION = '1.5.1'

export const ROOT = resolve(import.meta.dirname, '..')

/**
 * Load .env (or .env.testing when APP_ENV is "testing") without overriding variables already set, so Docker's
 * environment wins over the file just as it did with Laravel.
 */
function loadEnvFile(): void {
    const testing = process.env.APP_ENV === 'testing' || process.env.NODE_ENV === 'test' || process.env.VITEST !== undefined
    const file = join(ROOT, testing ? '.env.testing' : '.env')
    if (existsSync(file)) {
        loadEnv(readFileSync(file, 'utf8'))
    }
}

/**
 * Set the variables of an env file that aren't set yet, expanding ${NAME} references to variables set earlier
 * (MAIL_FROM_NAME="${APP_NAME}") as Laravel's phpdotenv did. A bare $ is kept, so values such as CurseForge API
 * keys ($2a$10$...) are read as written.
 */
export function loadEnv(contents: string): void {
    for (const [name, value] of Object.entries(dotenv.parse(contents))) {
        if (process.env[name] === undefined) {
            process.env[name] = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, reference: string) => process.env[reference] ?? '')
        }
    }
}

loadEnvFile()

function env(name: string, fallback = ''): string {
    const value = process.env[name]
    if (value === undefined || value === 'null' || value === '(null)') {
        return fallback
    }
    return value
}

function bool(name: string, fallback: boolean): boolean {
    const value = env(name, fallback ? 'true' : 'false').toLowerCase()
    return ['1', 'true', 'on', 'yes'].includes(value)
}

function int(name: string, fallback: number): number {
    const parsed = Number.parseInt(env(name, String(fallback)), 10)
    return Number.isNaN(parsed) ? fallback : parsed
}

/** Laravel's Str::finish */
function finish(value: string, cap: string): string {
    return value.endsWith(cap) ? value : value + cap
}

export type DatabaseProvider = 'postgresql' | 'mysql' | 'sqlite'

function databaseProvider(connection: string): DatabaseProvider {
    switch (connection) {
        case 'pgsql':
        case 'postgres':
        case 'postgresql':
            return 'postgresql'
        case 'sqlite':
            return 'sqlite'
        default:
            return 'mysql'
    }
}

function buildConfig() {
    const appEnv = env('APP_ENV', 'production')
    return {
        app: {
            name: env('APP_NAME', 'Technic Solder'),
            env: appEnv,
            debug: bool('APP_DEBUG', false),
            url: env('APP_URL', 'http://localhost').replace(/\/+$/, ''),
            key: env('APP_KEY'),
            timezone: env('APP_TIMEZONE', 'UTC'),
            port: int('PORT', 3000),
            bcryptRounds: int('BCRYPT_ROUNDS', 12),
        },
        database: {
            connection: env('DB_CONNECTION', 'mysql'),
            provider: databaseProvider(env('DB_CONNECTION', 'mysql')),
            url: env('DB_URL'),
            host: env('DB_HOST', '127.0.0.1'),
            port: int('DB_PORT', databaseProvider(env('DB_CONNECTION', 'mysql')) === 'postgresql' ? 5432 : 3306),
            database: env('DB_DATABASE', 'solder'),
            username: env('DB_USERNAME', 'root'),
            password: env('DB_PASSWORD'),
        },
        redis: {
            host: env('REDIS_HOST', '127.0.0.1'),
            port: int('REDIS_PORT', 6379),
            password: env('REDIS_PASSWORD') || undefined,
        },
        /** "redis" or "array" (in memory, for tests and single-process setups) */
        cacheStore: env('CACHE_STORE', 'redis') === 'redis' ? 'redis' : 'array',
        /** "redis" runs jobs in the worker process; "sync" runs them during the request */
        queueConnection: env('QUEUE_CONNECTION', 'sync') === 'redis' ? 'redis' : 'sync',
        session: {
            driver: env('SESSION_DRIVER', 'redis') === 'redis' ? 'redis' : 'memory',
            lifetimeMinutes: int('SESSION_LIFETIME', 120),
            cookie: env('SESSION_COOKIE', 'solder_session'),
            secure: bool('SESSION_SECURE_COOKIE', false),
        },
        mail: {
            host: env('MAIL_HOST'),
            port: int('MAIL_PORT', 587),
            username: env('MAIL_USERNAME'),
            password: env('MAIL_PASSWORD'),
            scheme: env('MAIL_SCHEME'),
            mailer: env('MAIL_MAILER', 'smtp'),
            fromAddress: env('MAIL_FROM_ADDRESS'),
            fromName: env('MAIL_FROM_NAME', 'Technic Solder'),
        },
        /** Skip the Have I Been Pwned check on new passwords (it calls an external API) */
        checkCompromisedPasswords: bool('SOLDER_CHECK_COMPROMISED_PASSWORDS', appEnv !== 'testing'),
        sanctum: {
            /** Minutes until API tokens expire; null for never */
            expiration: env('SANCTUM_TOKEN_EXPIRATION') === '' ? null : int('SANCTUM_TOKEN_EXPIRATION', 0),
            tokenPrefix: env('SANCTUM_TOKEN_PREFIX', 'sldr_'),
        },
        solder: {
            /** Location of the mod repository: a URL or an absolute path, with a trailing slash */
            repo_location: finish(env('SOLDER_REPO_LOCATION', '/var/www/mods.example.com/'), '/'),
            /** Where the launcher downloads files from, with a trailing slash */
            mirror_url: finish(env('SOLDER_MIRROR_URL', 'http://mods.example.com/'), '/'),
            md5_connect_timeout: int('SOLDER_MD5_CONNECT_TIMEOUT', 5),
            md5_file_timeout: int('SOLDER_MD5_FILE_TIMEOUT', 30),
            /** Disable public reads of the /mod API endpoints */
            disable_mod_api: bool('SOLDER_DISABLE_MOD_API', false),
            /** Show advanced UI settings, including Mojang Java runtime overrides */
            advanced_mode: bool('SOLDER_ADVANCED_MODE', false),
            /** Enable password reset by email */
            mail_enabled: bool('MAIL_ENABLED', false),
            cors_allowed_origins: env('SOLDER_CORS_ORIGINS', '*'),
            initial_admin_email: env('SOLDER_INITIAL_ADMIN_EMAIL', 'admin@example.com'),
            initial_admin_password: env('SOLDER_INITIAL_ADMIN_PASSWORD'),
            curseforge_api_key: env('CURSEFORGE_API_KEY'),
            discord_webhook: env('SOLDER_DISCORD_WEBHOOK'),
            discord_bot_token: env('SOLDER_DISCORD_BOT_TOKEN'),
            discord_user_id: env('SOLDER_DISCORD_USER_ID'),
            scheduled_update_checks: bool('SOLDER_SCHEDULED_UPDATE_CHECKS', true),
        },
        paths: {
            root: ROOT,
            public: join(ROOT, 'public'),
            views: join(ROOT, 'resources/views'),
            /** Laravel's storage/app/private ("local" disk) */
            storage: join(ROOT, env('SOLDER_STORAGE_PATH', 'storage/app/private')),
        },
    }
}

export type Config = ReturnType<typeof buildConfig>

/** Application configuration. Mutable so tests can change settings, like Laravel's config()->set(). */
export const config: Config = buildConfig()

/** Reset configuration to what the environment says (between tests). */
export function resetConfig(): void {
    Object.assign(config, buildConfig())
}

export function isProduction(): boolean {
    return config.app.env === 'production'
}

export function isTesting(): boolean {
    return config.app.env === 'testing'
}
