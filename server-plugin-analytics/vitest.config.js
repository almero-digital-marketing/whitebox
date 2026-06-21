import { defineConfig } from 'vitest/config'

// whitebox-pro-server is `npm link`'d in for development; this resolves through
// node_modules/whitebox-pro-server (a symlink to the sibling checkout in polyrepo).
export default defineConfig({
  test: {
    globalSetup: './node_modules/whitebox-pro-server/tests/setup/neon.js',
    pool: 'forks',
  },
})
