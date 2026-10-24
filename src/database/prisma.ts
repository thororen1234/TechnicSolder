import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { config, ROOT } from '../config.js'
import type { Prisma, PrismaClient as PostgresClient } from '../generated/prisma/postgresql/client.js'

type SqlDriverAdapterFactory = NonNullable<NonNullable<ConstructorParameters<typeof PostgresClient>[0]>['adapter']>

/**
 * The Prisma client for the configured database. Every provider's client has the same API for this schema,
 * so the PostgreSQL client's types stand in for all of them.
 */
export type PrismaClient = PostgresClient
export type TransactionClient = Prisma.TransactionClient
/** Either the client or a transaction, for functions that can run inside one */
export type Db = PrismaClient | TransactionClient

export function sqliteFile(): string {
    const name = config.database.database === ':memory:' ? 'storage/testing.sqlite' : config.database.database
    return isAbsolute(name) ? name : join(ROOT, name)
}

async function createAdapter(): Promise<SqlDriverAdapterFactory> {
    const { provider, url, host, port, database, username, password } = config.database
    switch (provider) {
        case 'postgresql': {
            const { PrismaPg } = await import('@prisma/adapter-pg')
            return new PrismaPg(url || { host, port, database, user: username, password })
        }
        case 'mysql': {
            const { PrismaMariaDb } = await import('@prisma/adapter-mariadb')
            return new PrismaMariaDb(url || { host, port, database, user: username, password, connectionLimit: 10 })
        }
        case 'sqlite': {
            const { PrismaBetterSqlite3 } = await import('@prisma/adapter-better-sqlite3')
            const file = sqliteFile()
            mkdirSync(dirname(file), { recursive: true })
            return new PrismaBetterSqlite3({ url: `file:${file}` })
        }
    }
}

/** Models with Laravel-style timestamps, and whether they have updated_at as well as created_at */
const TIMESTAMPED: Record<string, boolean> = {
    Modpack: true,
    Build: true,
    Mod: true,
    Modversion: true,
    BuildModversion: true,
    User: true,
    UserPermission: true,
    Client: true,
    ClientModpack: true,
    Key: true,
    PersonalAccessToken: true,
    ModpackImport: true,
    ActivityLog: false,
}

type Row = Record<string, unknown>

function withCreateTimestamps(model: string, data: Row): Row {
    const now = new Date()
    return {
        created_at: now,
        ...(TIMESTAMPED[model] ? { updated_at: now } : {}),
        ...data,
    }
}

function withUpdateTimestamp(model: string, data: Row): Row {
    return TIMESTAMPED[model] && !('updated_at' in data) ? { ...data, updated_at: new Date() } : data
}

/**
 * Fill created_at and updated_at the way Eloquent does, since the columns have no database defaults.
 */
function withTimestamps(base: PrismaClient): PrismaClient {
    return base.$extends({
        query: {
            $allModels: {
                async create({ model, args, query }) {
                    if (model in TIMESTAMPED) {
                        args.data = withCreateTimestamps(model, args.data as Row) as typeof args.data
                    }
                    return query(args)
                },
                async createMany({ model, args, query }) {
                    if (model in TIMESTAMPED) {
                        const rows = Array.isArray(args.data) ? args.data : [args.data]
                        args.data = rows.map((row) => withCreateTimestamps(model, row as Row)) as typeof args.data
                    }
                    return query(args)
                },
                async update({ model, args, query }) {
                    if (model in TIMESTAMPED) {
                        args.data = withUpdateTimestamp(model, args.data as Row) as typeof args.data
                    }
                    return query(args)
                },
                async updateMany({ model, args, query }) {
                    if (model in TIMESTAMPED) {
                        args.data = withUpdateTimestamp(model, args.data as Row) as typeof args.data
                    }
                    return query(args)
                },
                async upsert({ model, args, query }) {
                    if (model in TIMESTAMPED) {
                        args.create = withCreateTimestamps(model, args.create as Row) as typeof args.create
                        args.update = withUpdateTimestamp(model, args.update as Row) as typeof args.update
                    }
                    return query(args)
                },
            },
        },
    }) as unknown as PrismaClient
}

async function createClient(): Promise<PrismaClient> {
    const adapter = await createAdapter()
    const module =
        config.database.provider === 'postgresql'
            ? await import('../generated/prisma/postgresql/client.js')
            : config.database.provider === 'mysql'
              ? await import('../generated/prisma/mysql/client.js')
              : await import('../generated/prisma/sqlite/client.js')
    // The three generated clients share one API but TypeScript can't unify their constructors
    const Client = module.PrismaClient as unknown as new (options: { adapter: typeof adapter }) => PrismaClient
    return withTimestamps(new Client({ adapter }))
}

/** The database dialect, for the few queries Prisma can't express portably */
export function dialect(): 'postgresql' | 'mysql' | 'sqlite' {
    return config.database.provider
}

let client: PrismaClient | null = null

/** The shared Prisma client, connected on first use. */
export const db: PrismaClient = new Proxy({} as PrismaClient, {
    get(_target, property) {
        if (client === null) {
            throw new Error('The database is not connected yet. Call connectDatabase() first.')
        }
        const value = Reflect.get(client, property)
        return typeof value === 'function' ? value.bind(client) : value
    },
})

export async function connectDatabase(): Promise<PrismaClient> {
    client ??= await createClient()
    return client
}

export async function disconnectDatabase(): Promise<void> {
    await client?.$disconnect()
    client = null
}
