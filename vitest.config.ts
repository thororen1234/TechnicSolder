import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

export default defineConfig({
    // SWC instead of esbuild, for the decorator metadata NestJS uses
    plugins: [swc.vite({ module: { type: 'es6' } })],
    test: {
        globals: true,
        include: ['tests/**/*.test.ts'],
        setupFiles: ['tests/setup.ts'],
        pool: 'forks',
        testTimeout: 30_000,
        hookTimeout: 60_000,
    },
})
