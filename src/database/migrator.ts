import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import knexFactory, { type Knex } from 'knex'
import { config } from '../config.js'
import { migrations } from './migrations.js'
import { sqliteFile } from './prisma.js'

/** A Knex connection to the configured database, for schema changes. */
export function createKnex(): Knex {
    const { provider, url, host, port, database, username, password } = config.database
    switch (provider) {
        case 'postgresql':
            return knexFactory({ client: 'pg', connection: url || { host, port, database, user: username, password } })
        case 'mysql':
            return knexFactory({ client: 'mysql2', connection: url || { host, port, database, user: username, password } })
        case 'sqlite': {
            const file = sqliteFile()
            mkdirSync(dirname(file), { recursive: true })
            return knexFactory({ client: 'better-sqlite3', connection: { filename: file }, useNullAsDefault: true })
        }
    }
}

/**
 * Run the migrations not yet recorded in the `migrations` table, which is shared with the PHP version of Solder.
 *
 * @returns The names of the migrations that ran
 */
export async function migrate(log: (message: string) => void = () => {}): Promise<string[]> {
    const knex = createKnex()
    try {
        if (!(await knex.schema.hasTable('migrations'))) {
            await knex.schema.createTable('migrations', (table) => {
                table.increments('id')
                table.string('migration')
                table.integer('batch')
            })
        }
        const ran = new Set((await knex('migrations').select('migration')).map((row: { migration: string }) => row.migration))
        const pending = migrations.filter((migration) => !ran.has(migration.name))
        if (pending.length === 0) {
            return []
        }
        const { batch } = (await knex('migrations').max({ batch: 'batch' }).first()) as { batch: number | null }
        const nextBatch = (batch ?? 0) + 1
        for (const migration of pending) {
            log(`Migrating: ${migration.name}`)
            await migration.up(knex)
            await knex('migrations').insert({ migration: migration.name, batch: nextBatch })
        }
        return pending.map((migration) => migration.name)
    } finally {
        await knex.destroy()
    }
}

/** Every table the migrations create */
export const TABLES = [
    'modpacks', 'builds', 'mods', 'modversions', 'build_modversion', 'users', 'user_permissions', 'clients',
    'client_modpack', 'keys', 'personal_access_tokens', 'password_reset_tokens', 'jobs', 'failed_jobs',
    'activity_logs', 'build_downloads', 'modpack_imports',
] as const

/** Drop every table, for tests. */
export async function wipeDatabase(): Promise<void> {
    const knex = createKnex()
    try {
        for (const table of [...TABLES, 'migrations']) {
            await knex.schema.dropTableIfExists(table)
        }
    } finally {
        await knex.destroy()
    }
}
