import path from 'path'
import { fileURLToPath } from 'url'

import createAuth from 'whitebox-pro-server/auth'
import * as records from './records.js'
import * as ingest from './ingest.js'

import { mountRoutes, observeSchema } from './routes.js'
import { registerMcp } from './mcp.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Factory: crm({ auth: { secret: process.env.WB_CRM_TOKEN } }) in whitebox.config.js.
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
      const { db, connect, passports, awareness, context, logger: rootLogger } = ctx
      const logger = rootLogger.child({ component: 'crm' })
      const crmConfig = options

      const requireAuth = createAuth({ secret: crmConfig.auth?.secret, logger })

      // Singleton modules: capture deps once, in dependency order. ingest reaches
      // records directly via `import * as records`, so it only needs the
      // non-module values here.
      records.init({ db })
      ingest.init({ passports, awareness, logger })

      mountRoutes(app, { requireAuth, records, ingest, logger })
      registerMcp(ctx, { records, ingest })

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

      // CRM records flow into analytics' `/ask` via the generic context registry.
      // Facts already live in awareness so they're surfaced through awareness.recall;
      // no separate registration needed for them.
      context?.register?.('crm', async (passportId, { limit = 20, offset = 0 } = {}) => {
        const rows = await records.listForPassport(passportId, { limit, offset })
        return rows.map(r => ({
          source:      r.source,
          kind:        r.kind,
          external_id: r.external_id,
          status:      r.status,
          starts_at:   r.starts_at,
          data:        r.data,
        }))
      })

      logger.info('CRM plugin ready')

      return { records, ingest }
    },
  }
}
