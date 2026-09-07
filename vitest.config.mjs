import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,js,mjs}'],
    environment: 'node',
    // Server modules read process.env at import time (config); keep each
    // test file's module state isolated so env-dependent tests are stable.
    fileParallelism: false,
    sequence: { concurrent: false }
  }
})
