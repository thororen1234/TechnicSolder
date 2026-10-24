// Generate a Prisma client for every database Solder supports.
//
// Prisma fixes the provider in the schema, but a self-hosted Solder runs on whichever database its owner picked
// (DB_CONNECTION). prisma/schema.prisma is the source of truth; this writes a copy per provider and generates
// each into src/generated/prisma/<provider>. src/database/prisma.ts picks the right one at runtime.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'prisma/schema.prisma'), 'utf8')
const providers = process.argv.slice(2).length ? process.argv.slice(2) : ['postgresql', 'mysql', 'sqlite']

for (const provider of providers) {
    const schemaPath = join(root, 'prisma/generated', provider, 'schema.prisma')
    const schema = source
        .replace(/provider\s*=\s*"postgresql"/, `provider = "${provider}"`)
        .replace('../src/generated/prisma/postgresql', `../../../src/generated/prisma/${provider}`)
    mkdirSync(dirname(schemaPath), { recursive: true })
    writeFileSync(schemaPath, `// Generated from prisma/schema.prisma by scripts/prisma-generate.mjs. Do not edit.\n${schema}`)
    execFileSync(process.execPath, [join(root, 'node_modules/prisma/build/index.js'), 'generate', '--schema', schemaPath], {
        cwd: root,
        stdio: 'inherit',
    })
}
