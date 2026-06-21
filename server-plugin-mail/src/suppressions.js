import { z } from 'zod'

const TABLE = 'whitebox_mail_suppressions'

const REASONS = ['unsubscribed', 'bounced', 'complained', 'manual']

function normalize(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : null
}

const createSchema = z.object({
  email: z.string().email(),
  reason: z.enum(REASONS).optional(),
  notes: z.string().optional().nullable(),
})

// Dependencies captured once via init() — module-level singletons, no
// wrapping factory closure. Matches the core pattern (passports, sessions, …).
let db
let logger

export function init(deps) {
  db = deps.db
  logger = deps.logger
}

export async function check(email) {
  const e = normalize(email)
  if (!e) return null
  const row = await db(TABLE).where({ email: e }).first()
  return row || null
}

export async function checkMany(emails) {
  const normalized = [...new Set(emails.map(normalize).filter(Boolean))]
  if (!normalized.length) return new Set()
  const rows = await db(TABLE).whereIn('email', normalized).select('email')
  return new Set(rows.map(r => r.email))
}

export async function add({ email, reason = 'manual', source = 'manual', notes = null }) {
  const e = normalize(email)
  if (!e) return null
  if (!REASONS.includes(reason)) reason = 'manual'

  // Upsert on email; first reason wins unless overridden
  const [row] = await db(TABLE)
    .insert({ email: e, reason, source, notes })
    .onConflict('email')
    .merge({ reason, source, notes })
    .returning('*')
  return row
}

export async function remove(email) {
  const e = normalize(email)
  if (!e) return 0
  return await db(TABLE).where({ email: e }).del()
}

export async function list({ limit = 100, offset = 0 } = {}) {
  return await db(TABLE).orderBy('created_at', 'desc').limit(limit).offset(offset)
}

// --- HTTP handlers ---

export async function create(req, res) {
  const parsed = createSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  try {
    const row = await add({ ...parsed.data, source: 'api' })
    res.status(201).json(row)
  } catch (err) {
    logger.error({ err }, 'Failed to add suppression')
    res.status(500).json({ error: 'Failed to add suppression' })
  }
}

export async function destroy(req, res) {
  try {
    const deleted = await remove(req.params.email)
    if (!deleted) return res.status(404).end()
    res.status(204).end()
  } catch (err) {
    logger.error({ err }, 'Failed to remove suppression')
    res.status(500).json({ error: 'Failed to remove suppression' })
  }
}

export async function show(req, res) {
  const row = await check(req.params.email)
  if (!row) return res.status(404).end()
  res.json(row)
}

export async function index(req, res) {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000)
  const offset = parseInt(req.query.offset, 10) || 0
  const rows = await list({ limit, offset })
  res.json(rows)
}
