// whitebox-server-plugin-audiences
//
// AI audience plugin: reasons over per-passport awareness against declarative
// rules and reports custom events (Mode A) to Meta, TikTok and Google (GA4),
// so the platforms build the audiences. Management over REST + MCP.
//
// Plugin contract (see whitebox-server/src/plugins.js):
//   - migrate(db)        run our knex migrations
//   - register(app, ctx) wire routes, MCP tools, bus subscriptions, workers
//
// Full docs: ./docs

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as store from './store.js'
import * as rules from './rules.js'
import * as evaluator from './evaluator.js'
import * as delivery from './delivery.js'
import * as identity from './identity.js'
import * as consent from './consent.js'
import * as service from './service.js'
import * as rest from './rest.js'
import * as mcpTools from './mcp.js'
import { buildAdapters } from 'whitebox-adnetworks'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default {
  async migrate(db) {
    await db.migrate.latest({
      directory: path.join(__dirname, 'migrations'),
      tableName: 'whitebox_audience_migrations',
      loadExtensions: ['.js'],
    })
  },

  async register(app, ctx) {
    const cfg = ctx.config.audiences || {}
    const { logger } = ctx

    // --- wire the singletons (init() + free functions, like the core) ---
    store.init({ db: ctx.db })
    identity.init({ db: ctx.db, passports: ctx.passports })
    consent.init({ db: ctx.db, passports: ctx.passports, config: cfg.privacy })

    const adapters = buildAdapters(cfg.networks || {}, { logger })

    evaluator.init({
      awareness: ctx.awareness,   // recall() + population()
      ai: ctx.ai,         // prompt() / embed()
      context: ctx.context,       // collect() → CRM facts
      db: ctx.db,                 // metric aggregates over exposures
      config: cfg.evaluation || {},
      logger,
    })

    delivery.init({ adapters, identity, consent, store, logger })

    service.init({ store, rules, evaluator, delivery, adapters, identity, consent, logger })

    // --- REST (privileged management tier) ---
    rest.register(app, { service, secret: cfg.auth?.secret, logger })

    // --- MCP tools (behind config.mcp.auth.secret) ---
    mcpTools.register(ctx.mcp, { service, logger })

    // --- identity manifest onto the session-resolve response (decoupled) ---
    // The client capture shim reads this to know what to collect. See docs/06.
    if (ctx.sessions?.onResolve) {
      ctx.sessions.onResolve(() => ({ ad_identity_manifest: identity.manifest(adapters) }))
    }

    // --- dirty-tracking: re-evaluate a passport when its awareness changes ---
    // `awareness.recorded` is already published by the core on every exposure.
    ctx.events.subscribe('awareness.recorded', ({ data }) => {
      service.markDirty(data.passport_id).catch(err =>
        logger.warn({ err }, 'audiences: markDirty failed'))
    })

    // --- background workers: debounced eval + keep-warm re-fire ---
    service.startWorkers({ queue: ctx.queue, scheduler: ctx.scheduler })

    logger.info('Audiences plugin ready (%d networks)', adapters.length)

    return { service }   // exposed on ctx.plugins.audiences for other plugins/tests
  },
}
