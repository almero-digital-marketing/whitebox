import path from 'path'
import { fileURLToPath } from 'url'

import * as outbox from './outbox.js'
import * as sender from './sender.js'
import * as inbox from './inbox.js'
import * as status from './status.js'
import * as bulk from './bulk.js'
import * as suppressions from './suppressions.js'
import * as invalid from './invalid.js'
import { createRouter } from './router.js'
import { mountRoutes } from './routes.js'
import { registerMcp } from './mcp.js'
import createAuth from 'whitebox-server/auth'
import createNotify from 'whitebox-server/notify'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Factory: sms({ provider: twilio({…}), routes: { '+359': mobica({…}) }, auth }).
// `provider` is the default/fallback SMS provider; `routes` maps E.164 prefixes
// to provider overrides (longest match wins). Providers own send + webhook auth
// + payload parsing; the plugin owns outbox/status/suppressions/awareness.
export function sms(options = {}) {
  return {
    name: 'sms',

    async migrate(db) {
      await db.migrate.latest({
        directory: path.join(__dirname, 'migrations'),
        tableName: 'whitebox_sms_migrations',
      })
    },

    async register(app, ctx) {
      const { db, queue: q, events, webhooks, passports, sessions, templates, awareness, logger: rootLogger } = ctx
      const logger = rootLogger.child({ component: 'sms' })
      const smsConfig = options

      const router = createRouter({ provider: smsConfig.provider, routes: smsConfig.routes })
      const config = { ...ctx.config, sms: smsConfig }

      const { notify } = createNotify({ webhooksConfig: smsConfig.webhooks, events, webhooks })
      const requireAuth = createAuth({ secret: smsConfig.auth?.secret, logger })

      suppressions.init({ db, logger, defaultCountry: smsConfig.defaultCountry })
      invalid.init({ db, logger, defaultCountry: smsConfig.defaultCountry })
      sender.init({ router })
      outbox.init({ db, q, templates, passports, sessions, awareness, notify, config, logger })
      inbox.init({ config, db, passports, sessions, awareness, notify, logger, router })
      status.init({ awareness, notify, logger, router })
      bulk.init({ notify, logger, config })

      mountRoutes(app, { requireAuth })
      registerMcp(ctx, { db })

      // Stuck-row reaper: queued rows that never resolved → failed (no double-send).
      const interval = setInterval(
        () => outbox.markStuck(smsConfig.outbox?.stuckThresholdMs).catch(() => {}),
        smsConfig.outbox?.stuckCheckIntervalMs ?? 60_000,
      )
      interval.unref?.()

      logger.info('SMS plugin ready (providers: %s)', router.names().join(', ') || 'none')
    },
  }
}

export default sms
