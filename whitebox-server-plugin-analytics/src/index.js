import createAuth from 'whitebox-server/auth'
import { mountRoutes } from './routes.js'
import { registerMcp } from './mcp.js'

export default {
  name: 'analytics',

  async register(app, ctx) {
    const { config, awareness, openai, context, logger: rootLogger } = ctx
    const logger = rootLogger.child({ plugin: 'analytics' })
    const analyticsConfig = config.analytics || {}

    const requireAuth = createAuth({ secret: analyticsConfig.auth?.secret, logger })

    mountRoutes(app, { requireAuth, awareness, openai, context, logger })
    registerMcp(ctx, { awareness, openai, context })

    logger.info('Analytics plugin ready')
  },
}
