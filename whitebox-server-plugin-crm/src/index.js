import path from 'path'
import { fileURLToPath } from 'url'

import createAuth from 'whitebox-server/auth'
import * as records from './records.js'
import * as ingest from './ingest.js'

import { mountRoutes } from './routes.js'
import { registerMcp } from './mcp.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default {
  name: 'crm',

  async migrate(db) {
    await db.migrate.latest({
      directory: path.join(__dirname, 'migrations'),
      tableName: 'whitebox_crm_migrations',
    })
  },

  async register(app, ctx) {
    const { config, db, passports, awareness, context, logger: rootLogger } = ctx
    const logger = rootLogger.child({ plugin: 'crm' })
    const crmConfig = config.crm || {}

    const requireAuth = createAuth({ secret: crmConfig.auth?.secret, logger })

    // Singleton modules: capture deps once, in dependency order. ingest reaches
    // records directly via `import * as records`, so it only needs the
    // non-module values here.
    records.init({ db })
    ingest.init({ passports, awareness, logger })

    mountRoutes(app, { requireAuth, records, ingest, logger })
    registerMcp(ctx, { records, ingest })

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
