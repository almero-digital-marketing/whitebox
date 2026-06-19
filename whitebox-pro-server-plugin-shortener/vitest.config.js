import { defineConfig } from 'vitest/config'

// Unit tests stub the DB/passports/awareness — no Neon branch needed.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
  },
})
