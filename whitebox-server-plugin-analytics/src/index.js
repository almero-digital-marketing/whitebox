import createAuth from 'whitebox-server/auth'
import { mountRoutes } from './routes.js'
import { registerMcp } from './mcp.js'

// Factory: import { analytics } from 'whitebox-server-plugin-analytics' and call
// it with options in whitebox.config.js — analytics({ auth: { secret } }).
//
// Analytics is now purely query/recall over awareness. Ad-network conversion
// reporting lives in whitebox-server-plugin-conversions (composed networks).
export function analytics(options = {}) {
  return {
    name: 'analytics',

    async register(app, ctx) {
      const { awareness, context, logger: rootLogger } = ctx
      const logger = rootLogger.child({ component: 'analytics' })
      const analyticsConfig = options

      const requireAuth = createAuth({ secret: analyticsConfig.auth?.secret, logger })

      mountRoutes(app, { requireAuth, awareness, context, logger })
      registerMcp(ctx, { awareness, context })

      logger.info('Analytics plugin ready')
    },
  }
}
