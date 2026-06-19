// whitebox-pro-server-plugin-conversions
//
// Receives standard/custom conversion events from the browser
// (POST /conversions/events, via whitebox-pro-client-plugin-conversions), records
// each as a first-party awareness signal, and — consent permitting — fans it
// out to the ad networks (Meta CAPI / GA4 MP / TikTok Events API) through the
// shared whitebox-pro-adnetworks adapters, deduped against the browser pixels by
// event_id. The standard-event payloads validate against the SAME schemas the
// client uses (whitebox-pro-adnetworks/schemas).
//
// Factory: conversions({ networks, auth: { secret }, consent }).

import path from 'path'
import { fileURLToPath } from 'url'

import createAuth from 'whitebox-pro-server/auth'
import * as store from './store.js'
import * as ingest from './ingest.js'
import { createReporter } from './reporter.js'
import { mountRoutes } from './routes.js'
import { registerMcp } from './mcp.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function conversions(options = {}) {
  return {
    name: 'conversions',

    async migrate(db) {
      await db.migrate.latest({
        directory: path.join(__dirname, 'migrations'),
        tableName: 'whitebox_conversions_migrations',
      })
    },

    async register(app, ctx) {
      const { db, passports, awareness, logger: rootLogger } = ctx
      const logger = rootLogger.child({ component: 'conversions' })

      // The public POST ingress needs no secret. Auth only guards the admin GET
      // audit endpoint — so it's optional: lock that route with a 401 until a
      // secret is configured, rather than refusing to boot without one.
      const requireAuth = options.auth?.secret
        ? createAuth({ secret: options.auth.secret, logger })
        : (req, res) => res.status(401).json({ error: 'conversions: set auth.secret to use the audit endpoint' })

      const reporter = createReporter({ networks: options.networks || [], passports, logger })

      // Consent gate for ad-network fan-out. The client already gates on
      // marketing consent before sending, so the default is to honour that
      // (forward). Set consent.require:true to ALSO enforce a server-side source
      // — provide consent.check(passportId) or it default-denies.
      const consentCfg = options.consent || {}
      const consentOk = async (passportId) => {
        if (!consentCfg.require) return true
        if (typeof consentCfg.check === 'function') return !!(await consentCfg.check(passportId))
        return false
      }

      // Init singletons in dependency order.
      store.init({ db })
      ingest.init({ awareness, reporter, consentOk, logger, resolvePassport: passports.resolve })

      mountRoutes(app, { requireAuth, logger })
      registerMcp(ctx, { store })

      const eligible = reporter.networks().filter(n => n.eligible).map(n => n.name)
      logger.info('Conversions plugin ready (%s)', eligible.length ? `networks: ${eligible.join(', ')}` : 'awareness-only, no networks configured')

      return { reporter }
    },
  }
}
