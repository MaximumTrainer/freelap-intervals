import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '~': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.ts'],
    globals: false,
    // Several suites start their own Postgres (PGlite) and HTTP servers, which needs
    // both a longer budget than a pure unit test and a cap on how many run at once.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    poolOptions: { threads: { maxThreads: 4 } },
  },
})
