import path from 'path'
import { fileURLToPath } from 'url'

import * as store from './store.js'

// Facts — the core structured memory: an append-only, typed, value-queryable
// per-passport fact timeline (the structured twin of awareness). Channel-
// agnostic: any source writes facts via ctx.facts.record(); the term "crm"
// never appears here. See whitebox-pro-server/docs/temporal-facts.md.
//
// init + module-singleton, matching awareness / passports / sessions.

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let db
let logger
let passports

export function init(deps) {
  db = deps.db
  passports = deps.passports
  logger = deps.logger.child({ component: 'facts' })
  store.init({ db })
}

export async function migrate() {
  await db.migrate.latest({
    directory: path.join(__dirname, 'migrations'),
    tableName: 'whitebox_facts_migrations',
  })
}

// Follow the passport merge chain so an absorbed (merged-away) id maps to its
// survivor everywhere — a stale id never orphans facts under a tombstone.
// No-op when passports isn't wired (unit tests).
async function resolveId(id) {
  return id && passports?.resolve ? passports.resolve(id) : id
}

// Tag a value with its storage type. Callers may pass `type` explicitly
// (adapters usually do); otherwise we infer from the JS value.
function inferType(value) {
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'bool'
  if (value instanceof Date) return 'date'
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(value)) return 'date'
  return 'string'
}

const asArray = k => (k == null ? undefined : [].concat(k))

// Record one observed fact. `observed_at` defaults to now (valid-time); `type`
// is inferred when omitted. A value change is a new row — nothing is overwritten.
export async function record({ passport_id, key, value, type, source, observed_at, entity } = {}) {
  if (!passport_id) throw new Error('facts.record: passport_id is required')
  if (!key) throw new Error('facts.record: key is required')
  if (value === undefined) throw new Error('facts.record: value is required')

  const pid = await resolveId(passport_id)
  const row = await store.insert({
    passport_id: pid,
    key,
    value: JSON.stringify(value),   // jsonb; node-pg returns it parsed on read
    type: type || inferType(value),
    source: source || 'unknown',
    entity: entity || null,
    observed_at: observed_at ? new Date(observed_at) : new Date(),
  })
  logger?.debug?.({ passport_id: pid, key }, 'fact recorded')
  return row
}

// Current value of every key (or just `keys`) for a passport → { key: value }.
export async function current(passport_id, keys) {
  const pid = await resolveId(passport_id)
  const rows = await store.currentRows(pid, asArray(keys))
  return Object.fromEntries(rows.map(r => [r.key, r.value]))
}

// Value of every key (or just `keys`) as it stood at instant `at` → { key: value }.
export async function asOf(passport_id, at, keys) {
  const pid = await resolveId(passport_id)
  const rows = await store.asOfRows(pid, new Date(at), asArray(keys))
  return Object.fromEntries(rows.map(r => [r.key, r.value]))
}

// A single key's value — current, or as of `at`.
export async function get(passport_id, key, { at } = {}) {
  const obj = at ? await asOf(passport_id, at, key) : await current(passport_id, key)
  return obj[key]
}

// The full timeline of one key (oldest first): [{ value, type, observed_at, source }].
export async function history(passport_id, key) {
  const pid = await resolveId(passport_id)
  return store.historyRows(pid, key)
}
