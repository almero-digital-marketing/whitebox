import { z } from 'zod'
import { toE164 } from './phone.js'

const TABLE = 'whitebox_sms_invalid'

const REASONS = ['undeliverable', 'rejected', 'invalid_number']

// Default permanent-error classifier (a provider may override via classifyError).
// Permanent ⇒ the number is unusable, so the plugin blocklists instead of retrying.
const PERMANENT_PATTERNS = /invalid|not a valid|unreachable|blacklist|landline|does not exist|unknown subscriber|absent subscriber|barred/i

export function classifyError(err) {
  if (!err) return { permanent: false }
  const code = err.statusCode ?? err.status ?? err.code
  const numeric = typeof code === 'number' ? code : parseInt(code, 10)
  const is4xx = Number.isFinite(numeric) && numeric >= 400 && numeric < 500
  const msg = String(err.message || '')
  return {
    permanent: is4xx || PERMANENT_PATTERNS.test(msg),
    statusCode: Number.isFinite(numeric) ? numeric : null,
    message: msg,
  }
}

const createSchema = z.object({
  phone: z.string().min(3),
  reason: z.enum(REASONS).optional(),
  error_message: z.string().optional().nullable(),
})

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

export async function add({ phone, reason = 'undeliverable', source = 'provider', errorMessage = null }) {
  const p = toE164(phone, defaultCountry)
  if (!p) return null
  if (!REASONS.includes(reason)) reason = 'undeliverable'

  const [row] = await db(TABLE)
    .insert({ phone: p, reason, source, error_message: errorMessage })
    .onConflict('phone')
    .merge({ reason, source, error_message: errorMessage })
    .returning('*')
  return row
}

export async function remove(phone) {
  const p = toE164(phone)
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
    const { error_message: errorMessage, ...rest } = parsed.data
    const row = await add({ ...rest, errorMessage: errorMessage ?? null, source: 'api' })
    if (!row) return res.status(400).json({ error: 'invalid phone' })
    res.status(201).json(row)
  } catch (err) {
    logger.error({ err }, 'Failed to add invalid number')
    res.status(500).json({ error: 'Failed to add invalid number' })
  }
}

export async function destroy(req, res) {
  try {
    const deleted = await remove(req.params.phone)
    if (!deleted) return res.status(404).end()
    res.status(204).end()
  } catch (err) {
    logger.error({ err }, 'Failed to remove invalid number')
    res.status(500).json({ error: 'Failed to remove invalid number' })
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
