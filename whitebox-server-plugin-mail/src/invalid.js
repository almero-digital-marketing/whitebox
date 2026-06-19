import { z } from 'zod'

const TABLE = 'whitebox_mail_invalid'

const REASONS = ['bounced', 'rejected', 'invalid_syntax']

// Permanent-error classifier (option C: HTTP 4xx OR known keywords).
// Pure function — no dependencies, so it stands alone (no init needed).
const PERMANENT_PATTERNS = /invalid|no recipients|syntax|address rejected|not a valid email|free user|not allowed|does not exist|user unknown|mailbox/i

export function classifyMailerError(err) {
  if (!err) return { permanent: false }
  const code = err.statusCode ?? err.status ?? err.responseCode
  const numeric = typeof code === 'number' ? code : parseInt(code, 10)
  const is4xx = Number.isFinite(numeric) && numeric >= 400 && numeric < 500
  const msg = String(err.message || '')
  const matchesPattern = PERMANENT_PATTERNS.test(msg)
  return {
    permanent: is4xx || matchesPattern,
    statusCode: Number.isFinite(numeric) ? numeric : null,
    message: msg,
  }
}

function normalize(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : null
}

const createSchema = z.object({
  email: z.string().email(),
  reason: z.enum(REASONS).optional(),
  error_message: z.string().optional().nullable(),
})

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

export async function add({ email, reason = 'rejected', source = 'provider', errorMessage = null }) {
  const e = normalize(email)
  if (!e) return null
  if (!REASONS.includes(reason)) reason = 'rejected'

  const [row] = await db(TABLE)
    .insert({ email: e, reason, source, error_message: errorMessage })
    .onConflict('email')
    .merge({ reason, source, error_message: errorMessage })
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
    const { error_message: errorMessage, ...rest } = parsed.data
    const row = await add({ ...rest, errorMessage: errorMessage ?? null, source: 'api' })
    res.status(201).json(row)
  } catch (err) {
    logger.error({ err }, 'Failed to add invalid recipient')
    res.status(500).json({ error: 'Failed to add invalid recipient' })
  }
}

export async function destroy(req, res) {
  try {
    const deleted = await remove(req.params.email)
    if (!deleted) return res.status(404).end()
    res.status(204).end()
  } catch (err) {
    logger.error({ err }, 'Failed to remove invalid recipient')
    res.status(500).json({ error: 'Failed to remove invalid recipient' })
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
