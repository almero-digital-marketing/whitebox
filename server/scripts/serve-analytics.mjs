// Dev server for testing the analytics UI: boots core + registers ONLY the
// analytics plugin (no voip/PBX/etc.), on a known dev token. Reuses the real
// .env for db/redis/ai. Not for production.
//
//   node --env-file-if-exists=.env scripts/serve-analytics.mjs
//
// Then run the SPA (analytics-ui) with VITE_ANALYTICS_TOKEN=dev-analytics-token.

import '../src/quiet-deprecations.js'
import http from 'node:http'
import { load as loadConfig } from '../src/config.js'
import logger, { init as initLogger } from '../src/logger.js'
import createApp from '../src/app.js'
import * as db from '../src/db.js'
import * as redis from '../src/redis.js'
import * as queue from '../src/queue.js'
import * as events from '../src/events.js'
import * as cache from '../src/cache.js'
import * as lock from '../src/lock.js'
import * as webhooks from '../src/webhooks.js'
import * as connect from '../src/connect.js'
import * as passports from '../src/passports.js'
import * as sessions from '../src/sessions.js'
import * as ai from '../src/ai.js'
import * as context from '../src/context.js'
import * as awareness from '../src/awareness/index.js'
import * as facts from '../src/facts/index.js'
import * as selector from '../src/selector/index.js'
import * as mcp from '../src/mcp.js'
import { analytics } from 'whitebox-pro-server-plugin-analytics'
import { audiences } from 'whitebox-pro-server-plugin-audiences'
import { campaigns } from 'whitebox-pro-server-plugin-campaigns'

const DEV_TOKEN = 'dev-analytics-token'   // matches analytics-ui/.env.local

const config = await loadConfig({ argv: process.argv, env: process.env })
initLogger({ config })
logger.info('Analytics dev server booting (analytics plugin only)…')

await db.init({ config }); await redis.init({ config })
queue.init({ config }); await events.init({ config })
lock.init({ redis: redis.get() }); webhooks.init({ queue, config })
await passports.init({ db: db.get(), lock, config })
await sessions.init({ db: db.get(), passports })
await ai.init({ config })
context.init({ logger })
awareness.init({ db: db.get(), queue, ai, events, webhooks, config, logger, context, passports })
await awareness.migrate()
facts.init({ db: db.get(), passports, logger, config }); await facts.migrate()
selector.init({ db: db.get(), passports, logger, awareness, ai, config })

const app = createApp()
const server = http.createServer(app)
connect.init({ server, events, sessions })
sessions.register(app)
mcp.init({ config: config.mcp || {}, logger })

const ctx = {
  config, db: db.get(), redis: redis.get(), queue, events, cache, lock,
  webhooks, connect, passports, sessions, ai, awareness, facts, selector,
  context, mcp, plugins: {}, logger,
}
const plugin = analytics({ auth: { secret: DEV_TOKEN } })
await plugin.migrate(db.get())
await plugin.register(app, ctx)

// Audiences plugin — same dev token; no ad networks in dev (segments/resolve don't
// need them). Gives the UI the /audiences/* surface (segments, rules).
const audiencesPlugin = audiences({ auth: { secret: DEV_TOKEN }, networks: [] })
await audiencesPlugin.migrate(db.get())
ctx.plugins.audiences = await audiencesPlugin.register(app, ctx)   // { service } — campaigns reuses it

// Campaigns plugin — reuses the audiences service for resolution + consent. Register AFTER
// audiences. Same dev token so the UI + Mikser authenticate the same way. `dryRun` is the
// whitebox-config safety switch (default ON) — here it's read from WB_CAMPAIGNS_DRYRUN so it can
// be toggled without code edits. This dev server has no mail/sms providers wired, so going live
// (WB_CAMPAIGNS_DRYRUN=false) also needs a `deliver` hook that calls the mail/sms plugins.
const campaignDryRun = process.env.WB_CAMPAIGNS_DRYRUN !== 'false'
const campaignsPlugin = campaigns({ auth: { secret: DEV_TOKEN }, audiences: ctx.plugins.audiences.service, dryRun: campaignDryRun })
await campaignsPlugin.migrate(db.get())
await campaignsPlugin.register(app, ctx)

const port = Number(process.env.WB_PORT || config.port || 3000)
server.listen(port, () => logger.info('Analytics dev server ready on http://localhost:%d (token: %s)', port, DEV_TOKEN))

process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
