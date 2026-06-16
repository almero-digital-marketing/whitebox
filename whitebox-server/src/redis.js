import Redis from 'ioredis'
import logger from './logger.js'

let client

function createClient(config) {
  return new Redis({
    host: config.host,
    port: config.port,
    password: config.password,
    db: config.db || 0,
    maxRetriesPerRequest: null,
    lazyConnect: true,
  })
}

async function init(options) {
  const cfg = options.config.redis
  client = createClient(cfg)
  client.on('error', err => logger.error({ err }, 'Redis error'))
  await client.connect()
  logger.info('Redis connected: %s:%s', cfg.host, cfg.port)
}

function get() {
  if (!client) throw new Error('Redis not initialized')
  return client
}

export { init, get, createClient }
