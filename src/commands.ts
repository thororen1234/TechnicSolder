import { lookup } from 'node:dns/promises'
import { hostname } from 'node:os'
import { createInterface } from 'node:readline/promises'
import { hashPassword } from './auth/passwords.js'
import { config } from './config.js'
import { db } from './database/prisma.js'
import { checkAllBuildUpdates } from './jobs/check-all-build-updates.js'
import { random } from './support/str.js'

/**
 * The command line tasks behind `pnpm solder` (php artisan's solder:* commands).
 */
export interface Output {
    info(message: string): void
    warn(message: string): void
    table(rows: Record<string, unknown>[]): void
}

export const consoleOutput: Output = {
    info: (message) => console.log(message),
    warn: (message) => console.warn(message),
    table: (rows) => console.table(rows),
}

/** solder:setup: create the initial admin user, unless there already is a user */
export async function setup(options: { username?: string; interactive?: boolean }, output: Output = consoleOutput): Promise<number> {
    if ((await db.user.count()) > 0) {
        output.info('An admin user already exists. Skipping setup.')
        return 0
    }
    const username = options.username || 'admin'
    let email = config.solder.initial_admin_email
    let password = config.solder.initial_admin_password || random(16)
    if (options.interactive) {
        const prompt = createInterface({ input: process.stdin, output: process.stdout })
        email = (await prompt.question('Admin email: ')).trim()
        password = await prompt.question('Admin password: ')
        prompt.close()
    }
    let createdIp = '127.0.0.1'
    try {
        createdIp = (await lookup(hostname())).address
    } catch {
        // Keep the loopback address
    }
    const user = await db.user.create({ data: { username, email, password: await hashPassword(password), created_ip: createdIp } })
    await db.userPermission.create({ data: { user_id: user.id, solder_full: true } })
    output.info(`Admin user '${username}' created successfully.`)
    if (!options.interactive && !config.solder.initial_admin_password) {
        output.warn(`Generated password: ${password}`)
        output.warn('Change this password immediately after first login.')
    }
    return 0
}

/** solder:check-updates: check every modpack's latest build for mod updates */
export async function checkUpdates(output: Output = consoleOutput): Promise<number> {
    const summary = await checkAllBuildUpdates(null)
    if (summary.builds.length === 0) {
        output.info('Every modpack is up to date.')
        return 0
    }
    output.table(summary.builds.map((build) => ({ Modpack: build.modpack, Build: build.build, Updates: build.count, Mods: build.mods.join(', ') })))
    return 0
}
