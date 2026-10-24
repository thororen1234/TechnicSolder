import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'

const ENTRY_POINTS = ['resources/css/app.css', 'resources/js/app.ts']

/**
 * While `pnpm dev` runs, public/hot holds the dev server's URL so the server's vite() helper loads assets from
 * it (with hot reloading) instead of the build in public/build.
 */
function hotFile(): Plugin {
    const path = 'public/hot'
    return {
        name: 'solder-hot-file',
        configureServer(server) {
            server.httpServer?.once('listening', () => {
                const address = server.httpServer?.address()
                if (address && typeof address === 'object') {
                    const host = address.family === 'IPv6' ? `[${address.address}]` : address.address
                    mkdirSync('public', { recursive: true })
                    writeFileSync(path, server.resolvedUrls?.local[0]?.replace(/\/$/, '') ?? `http://${host === '[::]' || host === '0.0.0.0' ? 'localhost' : host}:${address.port}`)
                }
            })
            const clean = () => rmSync(path, { force: true })
            process.on('exit', clean)
            process.on('SIGINT', () => process.exit())
            process.on('SIGTERM', () => process.exit())
        },
    }
}

export default defineConfig({
    plugins: [tailwindcss(), hotFile()],
    publicDir: false,
    build: {
        outDir: 'public/build',
        emptyOutDir: true,
        manifest: 'manifest.json',
        rollupOptions: { input: ENTRY_POINTS },
    },
    server: {
        cors: true,
        origin: 'http://localhost:5173',
    },
})
