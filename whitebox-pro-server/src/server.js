import './quiet-deprecations.js'   // drop the benign punycode (DEP0040) warning — must be first
import http from 'http'
import path from 'path'
import { mkdir } from 'fs/promises'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import express from 'express'
import logger, { init as initLogger } from './logger.js'
import { load as loadConfig } from './config.js'
import createApp from './app.js'
import * as db from './db.js'
import * as redis from './redis.js'
import * as queue from './queue.js'
import * as events from './events.js'
import * as cache from './cache.js'
import * as lock from './lock.js'
import * as scheduler from './scheduler.js'
import * as webhooks from './webhooks.js'
import * as connect from './connect.js'
import * as passports from './passports.js'
import * as sessions from './sessions.js'
import * as ai from './ai.js'
import * as templates from './templates.js'
import * as awareness from './awareness/index.js'
import * as facts from './facts/index.js'
import * as selector from './selector/index.js'
import * as context from './context.js'
import * as mcp from './mcp.js'
import createAuth, { resolveMcpAuth } from './auth.js'
import { register as registerHealth } from './health.js'
import { load as loadPlugins } from './plugins.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Dev/demo CLI flags. --reset wipes awareness data on boot; --seed runs the
// integration demo seed once the server is listening. Both are dev conveniences
// (so you don't start the server and a seed script separately) — never pass them
// in production.
const RESET = process.argv.includes('--reset')
const SEED = process.argv.includes('--seed')

async function start() {
  // runtime is handed to the config factory (async (runtime) => ({...})) so it can
  // branch on flags/env when building the plugin list — mirrors mikser's runtime.
  const config = await loadConfig({ argv: process.argv, env: process.env })
  initLogger({ config })
  logger.info('Starting whitebox v2')

  await db.init({ config })
  await redis.init({ config })

  queue.init({ config })
  await events.init({ config })

  lock.init({ redis: redis.get() })
  scheduler.init({ queue })
  webhooks.init({ queue, config })

  await passports.init({ db: db.get(), lock, config })
  await sessions.init({ db: db.get(), passports })
  await ai.init({ config })

  let template = null
  if (config.mikser) {
    await mkdir(config.mikser.outputFolder, { recursive: true })
    templates.init({ config, logger })
    template = templates
  }

  context.init({ logger })
  awareness.init({
    db: db.get(), queue, ai, events, webhooks, config, logger, context, passports,
  })
  await awareness.migrate()
  logger.info('Awareness ready')

  // Facts — the core structured memory (the twin of awareness). Channel-agnostic;
  // any source writes via ctx.facts.record(). See docs/temporal-facts.md.
  facts.init({ db: db.get(), passports, logger, config })
  await facts.migrate()
  logger.info('Facts ready')

  // Selector — the query engine over the two memories (awareness + facts).
  // See docs/selector.md. Exposed on ctx as `selector`.
  selector.init({ db: db.get(), passports, logger })
  logger.info('Selector ready')

  if (RESET) {
    await awareness.reset()
    logger.warn('Awareness data wiped (--reset)')
  }

  const app = createApp()
  const server = http.createServer(app)

  connect.init({ server, events, sessions })
  registerHealth(app, { db: db.get(), redis: redis.get() })
  sessions.register(app)

  if (template) {
    app.use('/output', express.static(config.mikser.outputFolder))
  }

  const plugins = {}
  mcp.init({ config: config.mcp, logger })

  await loadPlugins(app, {
    config,
    db: db.get(),
    redis: redis.get(),
    queue,
    events,
    cache,
    lock,
    scheduler,
    webhooks,
    connect,
    passports,
    sessions,
    ai,
    template,
    awareness,
    facts,
    selector,
    context,
    mcp,
    plugins,
    logger,
  })

  // Mount MCP transport AFTER plugins have registered their tools/resources,
  // so the server's capability list is complete before the first client
  // connection. config.mcp.auth is a pluggable verifier — a static secret
  // (string / { secret }) by default, or a composed one like
  // auth0({ … }) from an external package. Omitted ⇒ no auth (dev only).
  const mcpAuth = resolveMcpAuth(config.mcp?.auth, { logger })
  await mcp.mount(app, { path: config.mcp?.path ?? '/mcp', auth: mcpAuth })

  await new Promise((resolve, reject) => {
    server.listen(config.port, err => err ? reject(err) : resolve())
  })

  logger.info('Server listening on port %d', config.port)

  // --seed: run the integration demo seed against ourselves now that ingress is
  // live and the embed worker is running. Spawned as a child so the demo content
  // stays in examples/ (not in the server core); runs in the background while the
  // server keeps serving. Dev only.
  if (SEED) {
    const seedPath = path.resolve(__dirname, '../../examples/integration/seed.mjs')
    logger.warn('Seeding demo data (--seed)')
    const child = spawn(process.execPath, [seedPath], {
      stdio: 'inherit',
      env: { ...process.env, WB_SERVER: `http://localhost:${config.port}` },
    })
    child.on('exit', code => logger.info('Seed finished (exit %s)', code ?? 0))
    child.on('error', err => logger.error({ err }, 'Seed failed to start'))
  }

  async function shutdown(signal) {
    logger.info('Shutting down (%s)', signal)
    server.close()
    await queue.close()
    await db.get().destroy()
    redis.get().disconnect()
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

start().catch(err => {
  logger.fatal({ err }, 'Startup failed')
  process.exit(1)
})
