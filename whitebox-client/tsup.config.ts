import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index:        'src/index.js',
    orchestrator: 'src/orchestrator.js',
    activity:     'src/activity.js',
    consent:      'src/consent.js',
    identity:     'src/identity.js',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2020',
  splitting: false,
  treeshake: true,
  external: ['socket.io-client'],
  esbuildOptions(options) {
    options.legalComments = 'none'
  },
})
