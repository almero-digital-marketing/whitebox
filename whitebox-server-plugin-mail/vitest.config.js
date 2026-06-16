import { defineConfig } from 'vitest/config'

// whitebox-server is `npm link`'d in for development; this resolves through
// node_modules/whitebox-server (a symlink to the sibling checkout in polyrepo).
export default defineConfig({
  test: {
    globalSetup: './node_modules/whitebox-server/tests/setup/neon.js',
    pool: 'forks',
  },
})
