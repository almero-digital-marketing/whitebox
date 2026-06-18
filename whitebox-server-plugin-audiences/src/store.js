// Data access. Thin knex wrappers — no business logic. init() + free functions.

let db

const RULES = 'whitebox_audience_rules'
const MATCHES = 'whitebox_audience_matches'
const DELIVERIES = 'whitebox_audience_deliveries'
const SUPPRESSION = 'whitebox_audience_suppression'
const IDENTITIES = 'whitebox_audience_identities'
const FACT_KEYS = 'whitebox_audience_fact_keys'

export function init({ db: knex }) { db = knex }

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

// --- CRM fact-key discovery cache ---
export const listFactKeys = () => db(FACT_KEYS).orderBy('last_seen', 'desc')
export async function recordFactKeys(facts = {}) {
  for (const [key, value] of Object.entries(facts)) {
    const type = value == null ? 'null'
      : typeof value === 'number' ? 'number'
      : typeof value === 'boolean' ? 'bool'
      : /^\d{4}-\d{2}-\d{2}/.test(String(value)) ? 'date' : 'string'
    await db(FACT_KEYS).insert({ key, type, sample: JSON.stringify(value), seen_count: 1 })
      .onConflict('key').merge({ type, sample: JSON.stringify(value), last_seen: db.fn.now(), seen_count: db.raw('?? + 1', [`${FACT_KEYS}.seen_count`]) })
  }
}
