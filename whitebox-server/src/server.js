import http from 'http'
import { mkdir } from 'fs/promises'
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
import * as openai from './openai.js'
import * as templates from './templates.js'
import * as awareness from './awareness/index.js'
import * as context from './context.js'
import * as mcp from './mcp.js'
import createAuth from './auth.js'
import { register as registerHealth } from './health.js'
import { load as loadPlugins } from './plugins.js'

async function start() {
  const config = await loadConfig()
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
  await openai.init({ config })

  let template = null
  if (config.mikser) {
    await mkdir(config.mikser.outputFolder, { recursive: true })
    templates.init({ config, logger })
    template = templates
  }

  awareness.init({
    db: db.get(), queue, openai, events, webhooks, config, logger,
  })
  await awareness.migrate()
  logger.info('Awareness ready')

  const app = createApp()
  const server = http.createServer(app)

  connect.init({ server, events, sessions })
  registerHealth(app, { db: db.get(), redis: redis.get() })
  sessions.register(app)

  if (template) {
    app.use('/output', express.static(config.mikser.outputFolder))
  }

  const plugins = {}
  context.init({ logger })
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
    openai,
    template,
    awareness,
    context,
    mcp,
    plugins,
    logger,
  })

  // Mount MCP transport AFTER plugins have registered their tools/resources,
  // so the server's capability list is complete before the first client
  // connection. Auth is optional — omitted iff config.mcp.auth.secret is
  // unset, which is fine for local development. Production should always
  // configure a secret.
  const mcpAuth = config.mcp?.auth?.secret
    ? createAuth({ secret: config.mcp.auth.secret, logger })
    : null
  await mcp.mount(app, { path: config.mcp?.path ?? '/mcp', auth: mcpAuth })

  await new Promise((resolve, reject) => {
    server.listen(config.port, err => err ? reject(err) : resolve())
  })

  logger.info('Server listening on port %d', config.port)

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
