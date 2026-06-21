import logger from './logger.js'

const TABLE = 'whitebox_sessions'

const UTM_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']

let db
let passports

export async function init(options) {
  db = options.db
  passports = options.passports
  const exists = await db.schema.hasTable(TABLE)
  if (!exists) {
    await db.schema.createTable(TABLE, t => {
      t.increments('id')
      t.uuid('passport_id').references('id').inTable('whitebox_passports')
      t.string('utm_source', 128)
      t.string('utm_medium', 128)
      t.string('utm_campaign', 128)
      t.string('utm_term', 128)
      t.string('utm_content', 128)
      t.string('referrer', 1024)
      t.timestamp('started_at').notNullable().defaultTo(db.fn.now())
      t.timestamp('ended_at')
      t.index('passport_id')
    })
    logger.info('Sessions table created')
  } else if (!(await db.schema.hasColumn(TABLE, 'referrer'))) {
    // awareness/store.js joins sessions and selects s.referrer — ensure it exists.
    await db.schema.alterTable(TABLE, t => t.string('referrer', 1024))
    logger.info('Sessions table: added referrer column')
  }
}

export async function start(passportId, utms = {}) {
  const resolvedId = passportId ? await passports.resolve(passportId) : null
  const data = { passport_id: resolvedId }
  for (const field of UTM_FIELDS) {
    if (utms[field]) data[field] = utms[field]
  }
  if (utms.referrer) data.referrer = utms.referrer
  const [session] = await db(TABLE).insert(data).returning('*')
  return session
}

export async function end(sessionId) {
  await db(TABLE).where({ id: sessionId }).whereNull('ended_at').update({ ended_at: new Date() })
}

export async function findActive(passportId) {
  const resolvedId = passportId ? await passports.resolve(passportId) : null
  if (!resolvedId) return null
  const session = await db(TABLE).where({ passport_id: resolvedId }).whereNull('ended_at').orderBy('started_at', 'desc').first()
  return session
}

export async function findById(id) {
  const session = await db(TABLE).where({ id }).first()
  return session
}

export async function resolve(passportId, utms = {}) {
  let session = passportId ? await findActive(passportId).catch(() => null) : null
  if (!session) session = await start(passportId || null, utms).catch(() => null)
  return session
}

export function register(app) {
  // The browser SDK calls this at startup. Mints a passport for a new visitor
  // (or reuses the one it sends back), opens/finds a session, and returns
  // camelCase ids the client stores and carries on the socket handshake.
  app.post('/sessions/resolve', async (req, res) => {
    try {
      const { passport_id: passportId, utms: bodyUtms = {}, referrer } = req.body || {}
      const utms = { ...bodyUtms, ...(referrer ? { referrer } : {}) }
      for (const field of UTM_FIELDS) {
        if (req.query[field]) utms[field] = req.query[field]
      }
      const resolvedPassport = await passports.identify(passportId || null)
      let session = await findActive(resolvedPassport).catch(() => null)
      if (!session) session = await start(resolvedPassport, utms)
      res.json({ passportId: resolvedPassport, sessionId: session.id })
    } catch (err) {
      logger.error({ err }, 'Failed to resolve session')
      res.status(500).json({ error: 'Failed to resolve session' })
    }
  })
}
