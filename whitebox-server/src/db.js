import knex from 'knex'
import logger from './logger.js'

let db

function init(options) {
  const cfg = options.config.db
  db = knex({
    client: 'pg',
    connection: {
      host: cfg.host,
      port: cfg.port,
      database: cfg.database,
      user: cfg.user,
      password: cfg.password,
      ssl: cfg.ssl,
    },
    pool: { min: 2, max: 10 },
    acquireConnectionTimeout: 10000,
  })

  return db.raw('SELECT 1').then(() => {
    logger.info('Database connected: %s:%s/%s', cfg.host, cfg.port, cfg.database)
  })
}

function get() {
  if (!db) throw new Error('Database not initialized')
  return db
}

export { init, get }
