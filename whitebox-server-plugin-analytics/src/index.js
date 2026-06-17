import createAuth from 'whitebox-server/auth'
import { mountRoutes } from './routes.js'
import { registerMcp } from './mcp.js'
import { createReporter } from './adnetworks.js'

export default {
  name: 'analytics',

  async register(app, ctx) {
    const { config, awareness, context, passports, logger: rootLogger } = ctx
    const logger = rootLogger.child({ component: 'analytics' })
    const analyticsConfig = config.analytics || {}

    const requireAuth = createAuth({ secret: analyticsConfig.auth?.secret, logger })

    mountRoutes(app, { requireAuth, awareness, context, logger })
    registerMcp(ctx, { awareness, context })

    // Ad-network reporting: standard conversion events via the shared adapters.
    // Configure under config.analytics.networks; call reportStandardEvent() from
    // your conversion handler (consent-gated). See README + whitebox-adnetworks.
    const reporter = createReporter({ config: analyticsConfig, passports, logger })
    if (reporter.adapters.length) {
      logger.info('Analytics ad-network reporting ready (%d networks)', reporter.adapters.length)
    }

    logger.info('Analytics plugin ready')
    return { reportStandardEvent: reporter.reportStandardEvent, adNetworks: reporter }
  },
}
