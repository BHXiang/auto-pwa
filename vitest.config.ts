import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Resolve the vendored dsh-tools/cordis stubs so tests run without a
 * DeepSeek Harness checkout (see vendor/dsh/dsh-tools.ts for rationale).
 */
export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-tools': fileURLToPath(new URL('./vendor/dsh/dsh-tools.ts', import.meta.url)),
      '@deepseek-ai/cordis': fileURLToPath(new URL('./vendor/dsh/cordis.ts', import.meta.url)),
      '@deepseek-ai/dsh-jobs': fileURLToPath(new URL('./vendor/dsh/dsh-jobs.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
})
