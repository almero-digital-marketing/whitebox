import { z } from 'zod'
import { toE164 } from './phone.js'

const TABLE = 'whitebox_sms_suppressions'

// Opt-out reasons. `unsubscribed` is the STOP-keyword reply; carriers/providers
// also enforce it network-side, but we keep our own list so preflight skips them.
const REASONS = ['unsubscribed', 'complained', 'manual']

const createSchema = z.object({
  phone: z.string().min(3),
  reason: z.enum(REASONS).optional(),
  notes: z.string().optional().nullable(),
})

// Dependencies captured once via init() — module-level singletons.
let db
let logger
let defaultCountry

export function init(deps) {
  db = deps.db
  logger = deps.logger
  defaultCountry = deps.defaultCountry
}

export async function check(phone) {
  const p = toE164(phone, defaultCountry)
  if (!p) return null
  const row = await db(TABLE).where({ phone: p }).first()
  return row || null
}

export async function checkMany(phones) {
  const normalized = [...new Set(phones.map(p => toE164(p, defaultCountry)).filter(Boolean))]
  if (!normalized.length) return new Set()
  const rows = await db(TABLE).whereIn('phone', normalized).select('phone')
  return new Set(rows.map(r => r.phone))
}

export async function add({ phone, reason = 'manual', source = 'manual', notes = null }) {
  const p = toE164(phone, defaultCountry)
  if (!p) return null
  if (!REASONS.includes(reason)) reason = 'manual'

  const [row] = await db(TABLE)
    .insert({ phone: p, reason, source, notes })
    .onConflict('phone')
    .merge({ reason, source, notes })
    .returning('*')
  return row
}

export async function remove(phone) {
  const p = toE164(phone, defaultCountry)
  if (!p) return 0
  return await db(TABLE).where({ phone: p }).del()
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
    if (!row) return res.status(400).json({ error: 'invalid phone' })
    res.status(201).json(row)
  } catch (err) {
    logger.error({ err }, 'Failed to add suppression')
    res.status(500).json({ error: 'Failed to add suppression' })
  }
}

export async function destroy(req, res) {
  try {
    const deleted = await remove(req.params.phone)
    if (!deleted) return res.status(404).end()
    res.status(204).end()
  } catch (err) {
    logger.error({ err }, 'Failed to remove suppression')
    res.status(500).json({ error: 'Failed to remove suppression' })
  }
}

export async function show(req, res) {
  const row = await check(req.params.phone)
  if (!row) return res.status(404).end()
  res.json(row)
}

export async function index(req, res) {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000)
  const offset = parseInt(req.query.offset, 10) || 0
  const rows = await list({ limit, offset })
  res.json(rows)
}
