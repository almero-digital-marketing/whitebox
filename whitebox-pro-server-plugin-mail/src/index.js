import path from 'path'
import { mkdir } from 'fs/promises'
import { fileURLToPath } from 'url'

import * as outbox from './outbox.js'
import * as mailer from './mailer.js'
import * as inbox from './inbox.js'
import * as tracking from './tracking.js'
import * as attachments from './attachments.js'
import * as suppressions from './suppressions.js'
import * as invalid from './invalid.js'
import * as bulk from './bulk.js'
import createAuth from 'whitebox-pro-server/auth'
import createNotify from 'whitebox-pro-server/notify'

import { mountRoutes } from './routes.js'
import { registerMcp } from './mcp.js'
import { startStuckReaper } from './stuck-reaper.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const REQUIRED_PROVIDER_METHODS = ['send', 'verifySignature', 'parseInbound', 'parseTracking']

// Factory: mail({ provider: mailgun({ … }), company, auth: { secret } }).
// `provider` is a composed mail-provider descriptor (whitebox-pro-mail-mailgun,
// whitebox-pro-mail-postmark, …) — it owns the SDK/transport, webhook authenticity,
// and the inbound/tracking payload shapes. The plugin stays provider-agnostic.
export function mail(options = {}) {
  return {
    name: 'mail',

    async migrate(db) {
      await db.migrate.latest({
        directory: path.join(__dirname, 'migrations'),
        tableName: 'whitebox_mail_migrations',
      })
    },

    async register(app, ctx) {
      const { db, queue: q, events, webhooks, passports, sessions, templates, awareness, logger: rootLogger } = ctx
      const logger = rootLogger.child({ component: 'mail' })
      const mailConfig = options

      const provider = mailConfig.provider
      if (!provider || typeof provider.send !== 'function') {
        throw new Error('mail(): a provider is required, e.g. mail({ provider: mailgun({ … }) })')
      }
      for (const m of REQUIRED_PROVIDER_METHODS) {
        if (typeof provider[m] !== 'function') {
          throw new Error(`mail(): provider "${provider.name || 'unknown'}" is missing required method ${m}()`)
        }
      }

      // Sub-module inits (outbox/inbox) read `config.mail`; give them a local
      // config with this plugin's options as the mail block so they stay unchanged.
      const config = { ...ctx.config, mail: mailConfig }

      // Resolve relative to cwd with a default (like voip's recordsFolder) so mkdir
      // never gets undefined when attachmentsFolder is omitted.
      const attachmentsFolder = path.resolve(process.cwd(), mailConfig.attachmentsFolder || 'mail-attachments')
      await mkdir(attachmentsFolder, { recursive: true })

      const { notify }  = createNotify({ webhooksConfig: mailConfig.webhooks, events, webhooks })
      const requireAuth = createAuth({ secret: mailConfig.auth?.secret, logger })

      // Singleton modules: capture deps once via init(), in dependency order.
      // Leaf modules first (no cross-module deps), then modules that import them.
      attachments.init({ folder: attachmentsFolder, baseUrl: '/mail/attachments' })
      mailer.init({ provider, attachmentsFolder })
      suppressions.init({ db, logger })
      invalid.init({ db, logger })

      // Lazy lookup so plugin load order doesn't matter: the shortener may load
      // after mail. Returns its service (for personalized short links) or undefined.
      const getShortener = () => ctx.plugins?.shortener?.service
      outbox.init({ db, q, templates, passports, sessions, awareness, notify, config, logger, provider, getShortener })
      inbox.init({ config, db, q, passports, sessions, awareness, notify, logger, provider })
      tracking.init({ notify, awareness, logger, provider })
      bulk.init({ notify, logger, provider })

      logger.info('Mail provider: %s', provider.name || 'unknown')

      mountRoutes(app, { attachmentsFolder, requireAuth })
      registerMcp(ctx, { db })
      startStuckReaper(mailConfig, logger)

      logger.info('Mail plugin ready')
    },
  }
}
