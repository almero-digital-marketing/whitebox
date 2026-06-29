// Data access. Thin knex wrappers — no business logic. init() + free functions.

let db

const RULES = 'whitebox_audience_rules'
const MATCHES = 'whitebox_audience_matches'
const DELIVERIES = 'whitebox_audience_deliveries'
const SUPPRESSION = 'whitebox_audience_suppression'
const IDENTITIES = 'whitebox_audience_identities'
const SEGMENTS = 'whitebox_audience_segments'
const AUDIENCES = 'whitebox_audiences'

export function init({ db: knex }) { db = knex }

// --- segments (chart-derived dynamic sub-queries) ---
export const listSegments = () => db(SEGMENTS).orderBy('created_at', 'desc')
export const getSegment = id => db(SEGMENTS).where({ id }).first()
export const getSegmentByKey = key => db(SEGMENTS).where({ predicate_key: key }).first()
export async function insertSegment(seg) {
  const [row] = await db(SEGMENTS).insert(seg).returning('*')
  return row
}
export async function updateSegment(id, fields) {
  const [row] = await db(SEGMENTS).where({ id }).update({ ...fields, updated_at: db.fn.now() }).returning('*')
  return row
}
export const deleteSegment = id => db(SEGMENTS).where({ id }).del()

// --- audiences (boolean compositions of segments) ---
export const listAudiences = () => db(AUDIENCES).orderBy('created_at', 'desc')
export const getAudience = id => db(AUDIENCES).where({ id }).first()
export const getAudienceByActivationId = activation_id => db(AUDIENCES).where({ activation_id }).first()
export async function upsertAudience(aud) {
  const [row] = await db(AUDIENCES).insert(aud)
    .onConflict('id').merge({ ...aud, updated_at: db.fn.now() }).returning('*')
  return row
}
// partial update of an existing audience — only the given columns (used for flags like
// client_side, so we don't have to round-trip name/rule/delivery through an upsert)
export async function updateAudience(id, fields) {
  const [row] = await db(AUDIENCES).where({ id }).update({ ...fields, updated_at: db.fn.now() }).returning('*')
  return row
}
export const deleteAudience = id => db(AUDIENCES).where({ id }).del()

// --- rules ---
export const listRules = () => db(RULES).orderBy('id')
export const getRule = id => db(RULES).where({ id }).first()
export async function upsertRule(rule) {
  const [row] = await db(RULES).insert(rule).onConflict('id').merge({ ...rule, updated_at: db.fn.now() }).returning('*')
  return row
}
export const deleteRule = id => db(RULES).where({ id }).del()
export const enabledRules = () => db(RULES).where({ enabled: true })

// --- matches (qualification + fire records) ---
export const getMatch = (ruleId, passportId) => db(MATCHES).where({ rule_id: ruleId, passport_id: passportId }).first()
export async function upsertMatch(m) {
  const [row] = await db(MATCHES).insert(m)
    .onConflict(['rule_id', 'passport_id']).merge({ ...m, last_evaluated_at: db.fn.now() }).returning('*')
  return row
}
export const ruleMatches = (ruleId, { qualified = true, limit = 50, offset = 0 } = {}) =>
  db(MATCHES).where({ rule_id: ruleId, qualified }).orderBy('last_evaluated_at', 'desc').limit(limit).offset(offset)
export const ruleMatchCount = (ruleId, qualified = true) =>
  db(MATCHES).where({ rule_id: ruleId, qualified }).count('* as n').first()
export const passportMatches = passportId =>
  db(MATCHES).where({ passport_id: passportId, qualified: true })
// matches due for a keep-warm re-fire (last_fired older than cutoff, still qualified)
export const dueForRefire = (ruleId, cutoff) =>
  db(MATCHES).where({ rule_id: ruleId, qualified: true }).andWhere(b => b.whereNull('last_fired_at').orWhere('last_fired_at', '<', cutoff))

// --- deliveries (audit) ---
export const insertDelivery = d => db(DELIVERIES).insert(d)
export const listDeliveries = ({ ruleId, network, status, limit = 50, offset = 0 } = {}) => {
  let q = db(DELIVERIES).orderBy('created_at', 'desc').limit(limit).offset(offset)
  if (ruleId) q = q.where({ rule_id: ruleId })
  if (network) q = q.where({ network })
  if (status) q = q.where({ status })
  return q
}

// --- suppression ---
export const isSuppressed = async passportId => !!(await db(SUPPRESSION).where({ passport_id: passportId }).first())
// Which of these passports are suppressed — ONE query for the whole cohort (a Set),
// instead of N per-passport round-trips. Used to gate a cohort without latency × N.
export const suppressedAmong = async (ids) => {
  if (!ids.length) return new Set()
  const rows = await db(SUPPRESSION).whereIn('passport_id', ids).select('passport_id')
  return new Set(rows.map(r => r.passport_id))
}
export const suppress = (passportId, reason) =>
  db(SUPPRESSION).insert({ passport_id: passportId, reason }).onConflict('passport_id').merge()
export const unsuppress = passportId => db(SUPPRESSION).where({ passport_id: passportId }).del()
export const listSuppression = () => db(SUPPRESSION).orderBy('created_at', 'desc')

// --- browser-collected identities ---
export const getIdentities = passportId => db(IDENTITIES).where({ passport_id: passportId }).first()
export async function saveIdentities(passportId, signals) {
  await db(IDENTITIES).insert({ passport_id: passportId, signals }).onConflict('passport_id')
    .merge({ signals: db.raw('?? || ?', [`${IDENTITIES}.signals`, JSON.stringify(signals)]), updated_at: db.fn.now() })
}
