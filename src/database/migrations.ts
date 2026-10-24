import type { Knex } from 'knex'

/**
 * The schema history, one entry per migration. Names match the Laravel migrations that created the schema of
 * existing installs (they are recorded in the `migrations` table), so an install that ran them under the PHP
 * version of Solder has nothing to run, and a partially upgraded one runs only what it is missing.
 *
 * Add new migrations to the end of the list. Never rename or reorder existing ones.
 */
export interface Migration {
    name: string
    up(knex: Knex): Promise<void>
}

/** Laravel's nullableTimestamps(): created_at and updated_at, second precision */
function nullableTimestamps(table: Knex.CreateTableBuilder): void {
    table.timestamp('created_at', { precision: 0, useTz: false }).nullable()
    table.timestamp('updated_at', { precision: 0, useTz: false }).nullable()
}

function timestamp(table: Knex.CreateTableBuilder | Knex.AlterTableBuilder, name: string): Knex.ColumnBuilder {
    return table.timestamp(name, { precision: 0, useTz: false })
}

export const migrations: Migration[] = [
    {
        name: '2013_02_20_014950_create_modpacks_table',
        async up(knex) {
            await knex.schema.createTable('modpacks', (table) => {
                table.increments('id')
                table.string('name').unique()
                table.string('slug').unique()
                table.string('recommended').nullable()
                table.string('latest').nullable()
                table.string('url').nullable()
                table.string('icon_md5').nullable()
                table.string('logo_md5').nullable()
                table.string('background_md5').nullable()
                nullableTimestamps(table)
            })
        },
    },
    {
        name: '2013_02_20_023938_create_builds_table',
        async up(knex) {
            await knex.schema.createTable('builds', (table) => {
                table.increments('id')
                table.integer('modpack_id')
                table.string('version')
                nullableTimestamps(table)
            })
        },
    },
    {
        name: '2013_02_20_033920_create_mods_table',
        async up(knex) {
            await knex.schema.createTable('mods', (table) => {
                table.increments('id')
                table.string('name').unique()
                table.text('description').nullable()
                table.string('author').nullable()
                table.string('link').nullable()
                nullableTimestamps(table)
            })
        },
    },
    {
        name: '2013_02_20_035755_create_modversions_table',
        async up(knex) {
            await knex.schema.createTable('modversions', (table) => {
                table.increments('id')
                table.integer('mod_id')
                table.string('version')
                table.string('md5')
                nullableTimestamps(table)
            })
        },
    },
    {
        name: '2013_02_20_042044_create_build_modversion_table',
        async up(knex) {
            await knex.schema.createTable('build_modversion', (table) => {
                table.increments('id')
                table.integer('modversion_id')
                table.integer('build_id')
                nullableTimestamps(table)
            })
        },
    },
    {
        name: '2013_02_20_043157_update_builds_table',
        async up(knex) {
            await knex.schema.alterTable('builds', (table) => {
                table.string('minecraft').notNullable().defaultTo('')
                table.string('forge').nullable()
            })
        },
    },
    {
        name: '2013_02_23_041950_update_mods_table',
        async up(knex) {
            await knex.schema.alterTable('mods', (table) => {
                table.string('pretty_name').notNullable().defaultTo('')
            })
        },
    },
    {
        name: '2013_02_27_184039_create_users_table',
        async up(knex) {
            await knex.schema.createTable('users', (table) => {
                table.increments('id')
                table.string('username')
                table.string('email')
                table.string('password')
                table.string('created_ip')
                table.string('last_ip').nullable()
                nullableTimestamps(table)
            })
        },
    },
    {
        name: '2013_03_01_030406_update_builds_table_again',
        async up(knex) {
            await knex.schema.alterTable('builds', (table) => {
                table.boolean('is_published').notNullable().defaultTo(false)
            })
        },
    },
    {
        name: '2013_03_07_230436_create_permissions_table',
        async up(knex) {
            await knex.schema.createTable('user_permissions', (table) => {
                table.increments('id')
                table.integer('user_id')
                table.boolean('solder_full').notNullable().defaultTo(false)
                table.boolean('solder_users').notNullable().defaultTo(false)
                table.boolean('solder_modpacks').notNullable().defaultTo(false)
                table.boolean('solder_mods').notNullable().defaultTo(false)
                table.boolean('solder_create').notNullable().defaultTo(false)
                table.boolean('mods_create').notNullable().defaultTo(false)
                table.boolean('mods_manage').notNullable().defaultTo(false)
                table.boolean('mods_delete').notNullable().defaultTo(false)
                table.string('modpacks').nullable()
                nullableTimestamps(table)
            })
        },
    },
    {
        name: '2013_03_13_200706_update_builds_md5',
        async up(knex) {
            await knex.schema.alterTable('builds', (table) => {
                table.string('minecraft_md5').notNullable().defaultTo('')
            })
        },
    },
    {
        name: '2013_04_14_032443_update_modpacks_add_order',
        async up(knex) {
            await knex.schema.alterTable('modpacks', (table) => {
                table.integer('order').notNullable().defaultTo(0)
            })
        },
    },
    {
        name: '2013_05_02_124140_add_modpack_hidden',
        async up(knex) {
            await knex.schema.alterTable('modpacks', (table) => {
                table.boolean('hidden').notNullable().defaultTo(true)
            })
            // Modpacks that existed before hiding was possible stay visible
            await knex('modpacks').update({ hidden: false })
        },
    },
    {
        name: '2013_12_08_214306_create_clients_tables',
        async up(knex) {
            await knex.schema.createTable('clients', (table) => {
                table.increments('id')
                table.string('name')
                table.string('uuid')
                nullableTimestamps(table)
            })
            await knex.schema.createTable('client_modpack', (table) => {
                table.increments('id')
                table.integer('client_id')
                table.integer('modpack_id')
                nullableTimestamps(table)
            })
        },
    },
    {
        name: '2013_12_08_224856_update_modpack_builds_private',
        async up(knex) {
            await knex.schema.alterTable('modpacks', (table) => {
                table.boolean('private').notNullable().defaultTo(false)
            })
            await knex.schema.alterTable('builds', (table) => {
                table.boolean('private').notNullable().defaultTo(false)
            })
        },
    },
    {
        name: '2013_12_23_094336_add_image_fields',
        async up(knex) {
            await knex.schema.alterTable('modpacks', (table) => {
                table.boolean('icon').notNullable().defaultTo(false)
                table.boolean('logo').notNullable().defaultTo(false)
                table.boolean('background').notNullable().defaultTo(false)
            })
        },
    },
    {
        name: '2014_01_24_122845_create_keys_table',
        async up(knex) {
            await knex.schema.createTable('keys', (table) => {
                table.increments('id')
                table.string('name')
                table.string('api_key')
                nullableTimestamps(table)
            })
        },
    },
    {
        name: '2014_10_19_042250_update_user_add_remember_me',
        async up(knex) {
            await knex.schema.alterTable('users', (table) => {
                table.string('remember_token').notNullable().defaultTo('')
            })
        },
    },
    {
        name: '2014_10_26_172144_new_permission_system',
        async up(knex) {
            await knex.schema.alterTable('user_permissions', (table) => {
                table.dropColumn('solder_create')
            })
            await knex.schema.alterTable('user_permissions', (table) => {
                table.dropColumn('solder_mods')
            })
            await knex.schema.alterTable('user_permissions', (table) => {
                table.dropColumn('solder_modpacks')
            })
            await knex.schema.alterTable('user_permissions', (table) => {
                table.boolean('solder_keys').notNullable().defaultTo(false)
                table.boolean('solder_clients').notNullable().defaultTo(false)
                table.boolean('modpacks_create').notNullable().defaultTo(false)
                table.boolean('modpacks_manage').notNullable().defaultTo(false)
                table.boolean('modpacks_delete').notNullable().defaultTo(false)
            })
        },
    },
    {
        name: '2014_12_12_235012_update_users_table_security',
        async up(knex) {
            await knex.schema.alterTable('users', (table) => {
                table.string('updated_by_ip').nullable()
                table.integer('created_by_user_id').notNullable().defaultTo(1)
                table.integer('updated_by_user_id').nullable()
            })
        },
    },
    {
        name: '2014_12_25_092343_update_mods_donate_link',
        async up(knex) {
            await knex.schema.alterTable('mods', (table) => {
                table.string('donatelink').nullable()
            })
        },
    },
    {
        name: '2015_01_30_142308_update_modpacks_table_add_image_links',
        async up(knex) {
            await knex.schema.alterTable('modpacks', (table) => {
                table.string('icon_url').nullable()
                table.string('logo_url').nullable()
                table.string('background_url').nullable()
            })
        },
    },
    {
        name: '2015_03_12_123951_update_builds_add_java_args',
        async up(knex) {
            await knex.schema.alterTable('builds', (table) => {
                table.string('min_java').nullable()
                table.integer('min_memory').nullable()
            })
        },
    },
    {
        name: '2015_09_05_210704_update_builds_remove_md5',
        async up(knex) {
            await knex.schema.alterTable('builds', (table) => {
                table.dropColumn('minecraft_md5')
            })
        },
    },
    {
        name: '2015_10_09_201116_update_modversions_add_filesize',
        async up(knex) {
            await knex.schema.alterTable('modversions', (table) => {
                table.integer('filesize').nullable()
            })
        },
    },
    {
        name: '2018_11_15_172107_update_mods_remove_donatelink',
        async up(knex) {
            await knex.schema.alterTable('mods', (table) => {
                table.dropColumn('donatelink')
            })
        },
    },
    {
        name: '2019_12_14_000001_create_personal_access_tokens_table',
        async up(knex) {
            await knex.schema.createTable('personal_access_tokens', (table) => {
                table.bigIncrements('id')
                table.string('tokenable_type')
                table.bigInteger('tokenable_id').unsigned()
                table.index(['tokenable_type', 'tokenable_id'])
                table.text('name')
                table.string('token', 64).unique()
                table.text('abilities').nullable()
                timestamp(table, 'last_used_at').nullable()
                timestamp(table, 'expires_at').nullable().index()
                nullableTimestamps(table)
            })
        },
    },
    {
        name: '2026_03_06_163626_add_two_factor_columns_to_users',
        async up(knex) {
            await knex.schema.alterTable('users', (table) => {
                table.text('two_factor_secret').nullable().after('password')
                table.text('two_factor_recovery_codes').nullable().after('two_factor_secret')
                timestamp(table, 'two_factor_confirmed_at').nullable().after('two_factor_recovery_codes')
            })
        },
    },
    {
        name: '2026_03_06_170000_create_password_reset_tokens_table',
        async up(knex) {
            await knex.schema.createTable('password_reset_tokens', (table) => {
                table.string('email').primary()
                table.string('token')
                timestamp(table, 'created_at').nullable()
            })
        },
    },
    {
        name: '2026_04_03_004450_add_notes_to_mods_and_modversions',
        async up(knex) {
            await knex.schema.alterTable('mods', (table) => {
                table.text('notes').nullable().after('link')
            })
            await knex.schema.alterTable('modversions', (table) => {
                table.text('notes').nullable().after('filesize')
            })
        },
    },
    {
        name: '2026_04_08_220505_add_indexes_to_build_modversion',
        async up(knex) {
            await knex.schema.alterTable('build_modversion', (table) => {
                table.index('modversion_id')
                table.index('build_id')
            })
        },
    },
    {
        name: '2026_04_08_232446_add_missing_indexes_to_tables',
        async up(knex) {
            await knex.schema.alterTable('modversions', (table) => table.index('mod_id'))
            await knex.schema.alterTable('builds', (table) => table.index('modpack_id'))
            await knex.schema.alterTable('user_permissions', (table) => table.index('user_id'))
            await knex.schema.alterTable('client_modpack', (table) => {
                table.index('client_id')
                table.index('modpack_id')
            })
            await knex.schema.alterTable('clients', (table) => table.index('uuid'))
            await knex.schema.alterTable('keys', (table) => table.index('api_key'))
        },
    },
    {
        name: '2026_09_13_220948_add_java_runtime_to_builds_table',
        async up(knex) {
            await knex.schema.alterTable('builds', (table) => {
                table.string('java_runtime').nullable()
            })
        },
    },
    {
        // Kept so the history matches Laravel's; the TypeScript queue uses Redis, not this table
        name: '2026_10_22_001635_create_jobs_table',
        async up(knex) {
            await knex.schema.createTable('jobs', (table) => {
                table.bigIncrements('id')
                table.string('queue').index()
                table.text('payload', 'longtext')
                table.smallint('attempts').unsigned()
                table.integer('reserved_at').unsigned().nullable()
                table.integer('available_at').unsigned()
                table.integer('created_at').unsigned()
            })
        },
    },
    {
        name: '2026_10_22_001636_create_failed_jobs_table',
        async up(knex) {
            await knex.schema.createTable('failed_jobs', (table) => {
                table.bigIncrements('id')
                table.string('uuid').unique()
                table.string('connection')
                table.string('queue')
                table.text('payload', 'longtext')
                table.text('exception', 'longtext')
                timestamp(table, 'failed_at').defaultTo(knex.fn.now())
                table.index(['connection', 'queue', 'failed_at'])
            })
        },
    },
    {
        name: '2026_10_22_001637_add_provider_source_to_modversions_table',
        async up(knex) {
            await knex.schema.alterTable('modversions', (table) => {
                table.string('provider', 32).nullable()
                table.string('provider_project_id').nullable()
                table.string('provider_version_id').nullable()
                table.index(['provider', 'provider_project_id'])
            })
        },
    },
    {
        name: '2026_10_22_032020_create_activity_logs_table',
        async up(knex) {
            await knex.schema.createTable('activity_logs', (table) => {
                table.bigIncrements('id')
                table.bigInteger('user_id').unsigned().nullable()
                table.bigInteger('modpack_id').unsigned().nullable()
                table.bigInteger('build_id').unsigned().nullable()
                table.string('action', 64)
                table.text('description')
                table.json('properties').nullable()
                timestamp(table, 'created_at').nullable()
                table.index(['modpack_id', 'created_at'])
                table.index(['build_id', 'created_at'])
                table.index('created_at')
            })
        },
    },
    {
        name: '2026_10_22_033318_add_environment_to_modversions_table',
        async up(knex) {
            await knex.schema.alterTable('modversions', (table) => {
                // "client" or "server" when the file only belongs on one side; null when it's needed on both
                table.string('environment', 16).nullable()
            })
        },
    },
    {
        name: '2026_10_22_033829_create_build_downloads_table',
        async up(knex) {
            await knex.schema.createTable('build_downloads', (table) => {
                table.bigIncrements('id')
                table.bigInteger('build_id').unsigned()
                table.date('date')
                table.integer('count').unsigned().notNullable().defaultTo(0)
                table.unique(['build_id', 'date'])
                table.index('date')
            })
        },
    },
    {
        name: '2026_10_22_121847_create_modpack_imports_table',
        async up(knex) {
            await knex.schema.createTable('modpack_imports', (table) => {
                table.bigIncrements('id')
                table.bigInteger('user_id').unsigned().nullable()
                table.bigInteger('modpack_id').unsigned().nullable()
                table.bigInteger('build_id').unsigned().nullable()
                table.string('name')
                table.string('slug').nullable()
                table.text('source')
                table.string('archive_path').nullable()
                table.string('build_version').nullable()
                table.boolean('overwrite').notNullable().defaultTo(false)
                table.string('status', 16)
                table.integer('imported').unsigned().notNullable().defaultTo(0)
                table.integer('skipped').unsigned().notNullable().defaultTo(0)
                table.json('problems').nullable()
                table.json('log').nullable()
                nullableTimestamps(table)
                table.index(['modpack_id', 'created_at'])
                table.index('created_at')
            })
        },
    },
]
