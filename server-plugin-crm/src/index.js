import path from 'path'
import { fileURLToPath } from 'url'

import createAuth from 'whitebox-pro-server/auth'
import * as state from './state.js'
import * as ingest from './ingest.js'

import { mountRoutes, observeSchema } from './routes.js'
import { registerMcp } from './mcp.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Factory: crm({ auth: { secret: process.env.WB_CRM_TOKEN } }) in whitebox.config.js.
//
// CRM is now a thin adapter: structured records land in the core *facts* memory
// (queryable by the selector as `filter.fact`), free-text notes land in awareness.
// It owns no store of its own — the migration only drops its retired records table.
export function crm(options = {}) {
  return {
    name: 'crm',

    async migrate(db) {
      await db.migrate.latest({
        directory: path.join(__dirname, 'migrations'),
        tableName: 'whitebox_crm_migrations',
      })
    },

    async register(app, ctx) {
      const { connect, passports, facts, awareness, context, logger: rootLogger } = ctx
      const logger = rootLogger.child({ component: 'crm' })
      const crmConfig = options

      const requireAuth = createAuth({ secret: crmConfig.auth?.secret, logger })

      // Singleton modules: capture deps once, in dependency order. ingest reaches
      // state directly via `import * as state`; state writes structured records
      // into core facts. Only non-module values come through init.
      state.init({ facts, logger })
      ingest.init({ passports, awareness, logger })

      mountRoutes(app, { requireAuth, state, ingest, logger })
      registerMcp(ctx, { state, ingest })

      // Client-reported observations arrive over the socket (whitebox-pro-client-plugin-crm).
      // Identity is the connection's passport — the trusted, handshake-bound one —
      // so the client can't report for someone else over the socket.
      connect?.onMessage(async ({ connectionId, event, data }) => {
        if (event !== 'crm.observe') return
        const visitor = connect.find(connectionId)
        if (!visitor?.passportId) return
        const parsed = observeSchema.safeParse(data)
        if (!parsed.success) { logger.warn({ err: parsed.error }, 'crm.observe validation failed'); return }
        await ingest.ingestObservations({ passport_id: visitor.passportId, observations: parsed.data.observations })
          .catch(err => logger.warn({ err }, 'crm.observe ingest failed'))
      })

      // Structured state flows into analytics' `/ask` via the generic context
      // registry. It now lives in core facts, so this surfaces the passport's
      // current facts ({ key: value }) as that customer's structured context.
      // (Free-text notes already live in awareness and surface via recall.)
      context?.register?.('crm', async (passportId) => {
        const current = await state.current(passportId)
        return Object.entries(current).map(([key, value]) => ({ key, value }))
      })

      logger.info('CRM plugin ready (facts adapter)')

      return { state, ingest }
    },
  }
}
