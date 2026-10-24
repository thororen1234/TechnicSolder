// Runs before every test file: each Vitest worker gets its own SQLite database and storage folder.
const worker = process.env.VITEST_POOL_ID ?? '1'
process.env.APP_ENV = 'testing'
process.env.DB_CONNECTION = 'sqlite'
process.env.DB_DATABASE = `storage/testing/db-${worker}.sqlite`
process.env.SOLDER_STORAGE_PATH = `storage/testing/app-${worker}`
