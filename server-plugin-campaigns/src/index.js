// whitebox-pro-server-plugin-campaigns
//
// Plan & execute email/SMS campaigns to audiences. Mikser upserts campaign content from outside
// (by external_id); the UI attaches audiences (many-to-many) and schedules. Executing locks the
// campaign with real stats; a sent campaign can spawn an Analytics performance report.
//
// Delivery: when a scheduled campaign comes due it is handed to the host-wired `deliver` hook,
// which calls the mail / sms plugins for the channel. `dryRun` (whitebox config; DEFAULT ON) is
// the safety switch — it records the projected reach as "sent" WITHOUT actually sending, so a
// misconfigured or half-built campaign can't blast real inboxes. Flip campaigns.dryRun=false in
// the config to go live; it can be changed at any time.
//
// Plugin contract (see whitebox-pro-server/src/plugins.js):
//   - migrate(db)        run our knex migrations
//   - register(app, ctx) wire routes; reuse the audiences plugin's service for resolution+consent
//
// Reuses ctx.plugins.audiences.service (resolveAudience, previewCohort, deliverableCohort), passed
// in by the host. Register the audiences plugin BEFORE campaigns.

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as store from './store.js'
import * as service from './service.js'
import * as rest from './rest.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Factory: campaigns({ auth: { secret }, audiences, dryRun, deliver }).
//   audiences — the audiences plugin's service (default: ctx.plugins.audiences.service)
//   dryRun    — record-but-don't-send safety switch (default TRUE; set false in config to go live)
//   deliver   — async ({ campaign, channel, subject, message, passportIds }) => { batch_id? }
//               the host wires this to the mail/sms plugins; only called for a LIVE (non-dry) send.
export function campaigns(options = {}) {
  return {
    name: 'campaigns',

    async migrate(db) {
      await db.migrate.latest({
        directory: path.join(__dirname, 'migrations'),
        tableName: 'whitebox_campaign_migrations',
        loadExtensions: ['.js'],
      })
    },

    async register(app, ctx) {
      const cfg = options
      const { logger } = ctx
      const audiences = options.audiences || ctx.plugins?.audiences?.service
      if (!audiences) logger.warn('campaigns: audiences service not wired — delivery preview + send will fail (register audiences first)')

      // Safety default: dry-run unless the config EXPLICITLY turns it off.
      const dryRun = options.dryRun !== false
      const deliver = options.deliver || null
      if (!dryRun && !deliver) logger.warn('campaigns: dryRun is OFF but no `deliver` hook is wired — live sends will fail until the mail/sms delivery is configured')

      store.init({ db: ctx.db })
      service.init({ store, audiences, dryRun, deliver, logger })

      rest.register(app, { service, secret: cfg.auth?.secret, logger })

      logger.info(`Campaigns plugin ready (delivery: ${dryRun ? 'dry-run' : 'live'})`)
      return { service }   // exposed for other plugins/tests
    },
  }
}
