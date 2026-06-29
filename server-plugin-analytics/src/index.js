import path from 'node:path'
import { fileURLToPath } from 'node:url'
import createAuth from 'whitebox-pro-server/auth'
import { mountRoutes } from './routes.js'
import { registerMcp } from './mcp.js'
import * as compositionStore from './composition/store.js'
import * as compose from './composition/compose.js'
import { mountComposition } from './composition/routes.js'

// Factory: import { analytics } from 'whitebox-pro-server-plugin-analytics' and call
// it with options in whitebox.config.js — analytics({ auth: { secret } }).
//
// Two surfaces:
//   - the original query/recall over awareness (recall · population · ask · …)
//   - the COMPOSITION layer (docs/analytics-concept.md): reports + widgets over the
//     core selector engine, the backend for the three-pane analytics console.
const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function analytics(options = {}) {
  return {
    name: 'analytics',

    // Own state: whitebox_reports / whitebox_widgets (the composition surface).
    async migrate(db) {
      await db.migrate.latest({
        directory: path.join(__dirname, 'migrations'),
        tableName: 'whitebox_analytics_migrations',
        loadExtensions: ['.js'],
      })
    },

    async register(app, ctx) {
      const { awareness, context, selector, ai, db, connect, passports, logger: rootLogger } = ctx
      const logger = rootLogger.child({ component: 'analytics' })
      const analyticsConfig = options

      const requireAuth = createAuth({ secret: analyticsConfig.auth?.secret, logger })

      // Original awareness query/recall conveniences (unchanged).
      mountRoutes(app, { requireAuth, awareness, context, logger })
      registerMcp(ctx, { awareness, context })

      // Composition surface — reports/widgets/resolve/compose over the core
      // selector + AI. Guarded: db + selector are absent in some unit tests.
      if (db && selector) {
        compositionStore.init({ db, connect })   // store broadcasts every mutation → all clients live
        compose.init({ db, ai, selector, awareness, logger })
        mountComposition(app, { requireAuth, selector, awareness, passports, logger })
        logger.info('Analytics composition surface ready (reports · resolve · compose)')
      } else {
        logger.warn('Analytics composition surface skipped (no db/selector in ctx)')
      }

      logger.info('Analytics plugin ready')
    },
  }
}
