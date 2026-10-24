import { checkUpdates, setup } from './commands.js'
import { connectDatabase, disconnectDatabase } from './database/prisma.js'
import { migrate } from './database/migrator.js'
import { closeRedis } from './support/cache.js'
import { generateKey } from './support/encrypter.js'

/**
 * Command line tasks, replacing `php artisan`:
 *
 *   solder migrate                     Create or update the database tables
 *   solder setup [--username=admin]    Create the initial admin user
 *   solder check-updates               Check every modpack's latest build for mod updates
 *   solder key:generate                Print a new APP_KEY
 */
const [command = 'help', ...args] = process.argv.slice(2)

function option(name: string): string | undefined {
    const prefix = `--${name}=`
    return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
}

const interactive = process.stdin.isTTY && !args.includes('--no-interaction') && !args.includes('-n')

try {
    switch (command) {
        case 'migrate': {
            const ran = await migrate((message) => console.log(message))
            console.log(ran.length === 0 ? 'Nothing to migrate.' : `Ran ${ran.length} migration(s).`)
            break
        }
        case 'setup':
            await connectDatabase()
            process.exitCode = await setup({ username: option('username'), interactive })
            break
        case 'check-updates':
            await connectDatabase()
            process.exitCode = await checkUpdates()
            break
        case 'key:generate':
            console.log(generateKey())
            break
        default:
            console.log('Usage: solder <migrate|setup|check-updates|key:generate>')
            process.exitCode = command === 'help' ? 0 : 1
    }
} catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
} finally {
    await disconnectDatabase()
    await closeRedis()
}
