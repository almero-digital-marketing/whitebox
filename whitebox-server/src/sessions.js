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
      t.timestamp('started_at').notNullable().defaultTo(db.fn.now())
      t.timestamp('ended_at')
      t.index('passport_id')
    })
    logger.info('Sessions table created')
  }
}

export async function start(passportId, utms = {}) {
  const resolvedId = passportId ? await passports.resolve(passportId) : null
  const data = { passport_id: resolvedId }
  for (const field of UTM_FIELDS) {
    if (utms[field]) data[field] = utms[field]
  }
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
  app.post('/sessions', async (req, res) => {
    try {
      const { passport_id: passportId } = req.body || {}
      const utms = {}
      for (const field of UTM_FIELDS) {
        if (req.query[field]) utms[field] = req.query[field]
      }
      const session = await start(passportId || null, utms)
      res.json(session)
    } catch (err) {
      logger.error({ err }, 'Failed to start session')
      res.status(500).json({ error: 'Failed to start session' })
    }
  })
}
