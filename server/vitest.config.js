import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: './tests/setup/neon.js',
    pool: 'forks',
    // All test files share one Neon branch; the real-DB suites (passports, facts)
    // TRUNCATE shared tables, so run files sequentially to stop them clobbering
    // each other. (Mocked-DB suites are fast; the cost is small.)
    fileParallelism: false,
  },
})
