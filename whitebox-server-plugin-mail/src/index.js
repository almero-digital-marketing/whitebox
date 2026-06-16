import path from 'path'
import { mkdir } from 'fs/promises'
import { fileURLToPath } from 'url'

import * as outbox from './outbox.js'
import * as mailer from './mailer.js'
import * as inbox from './inbox.js'
import * as tracking from './tracking.js'
import * as attachments from './attachments.js'
import * as signature from './signature.js'
import * as suppressions from './suppressions.js'
import * as invalid from './invalid.js'
import * as bulk from './bulk.js'
import createAuth from 'whitebox-server/auth'
import createNotify from 'whitebox-server/notify'

import { mountRoutes } from './routes.js'
import { registerMcp } from './mcp.js'
import { startStuckReaper } from './stuck-reaper.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const DEFAULT_REPLAY_WINDOW_MS = 5 * 60 * 1000

export default {
  name: 'mail',

  async migrate(db) {
    await db.migrate.latest({
      directory: path.join(__dirname, 'migrations'),
      tableName: 'whitebox_mail_migrations',
    })
  },

  async register(app, ctx) {
    const { config, db, queue: q, events, webhooks, passports, sessions, templates, awareness, logger: rootLogger } = ctx
    const logger = rootLogger.child({ plugin: 'mail' })
    const mailConfig = config.mail

    const attachmentsFolder = mailConfig.attachmentsFolder
    await mkdir(attachmentsFolder, { recursive: true })

    const { notify }  = createNotify({ webhooksConfig: mailConfig.webhooks, events, webhooks })
    const requireAuth = createAuth({ secret: mailConfig.auth?.secret, logger })

    // Singleton modules: capture deps once via init(), in dependency order.
    // Leaf modules first (no cross-module deps), then modules that import them.
    attachments.init({ folder: attachmentsFolder, baseUrl: '/mail/attachments' })
    mailer.init({ config })
    signature.init({
      webhookSigningKey: mailConfig.mailgun.webhookSigningKey,
      replayWindowMs:    mailConfig.webhookReplayWindowMs ?? DEFAULT_REPLAY_WINDOW_MS,
      logger,
    })
    suppressions.init({ db, logger })
    invalid.init({ db, logger })

    outbox.init({ db, q, templates, passports, sessions, awareness, notify, config, logger })
    inbox.init({ config, db, q, passports, sessions, awareness, notify, logger })
    tracking.init({ notify, awareness, logger })
    bulk.init({ notify, logger })

    mountRoutes(app, { attachmentsFolder, requireAuth })
    registerMcp(ctx, { db })
    startStuckReaper(mailConfig, logger)

    logger.info('Mail plugin ready')
  },
}
