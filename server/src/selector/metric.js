// Evaluate a `metric` over the awareness exposure stream. Two modes:
//   · evaluate(db, spec, …) → the passports whose per-passport aggregate satisfies
//                             a bound (the *gate*, used by filter.metric — §5)
//   · group(db, spec, { by }) → the TOTAL aggregate bucketed by a time grain or a
//                             dimension → [{ bucket, value }] (the *chart* — §7)
// Both share the same event filters; they differ only in what they GROUP BY.
//
// Dimensions reach their natural typed home (see docs/event-attributes.md):
//   · exposure columns   channel / direction / source            (low-cardinality, indexed)
//   · session columns    session: { utm_campaign: … }            (LEFT JOIN whitebox_sessions)
//   · open per-event dims attrs: { event: 'email_open', … }      (meta jsonb)
// `content` (substring on content_id) is DEPRECATED — content_id is untrusted/opaque
// and nothing structural may depend on it. It keeps resolving for now; nothing new
// uses it; it is removed once analytics migrates off (docs/event-attributes.md §4/§7).

const EXPOSURES = 'whitebox_awareness_exposures'
const SESSIONS = 'whitebox_sessions'
const MS = { h: 3600e3, d: 86400e3, w: 604800e3 }
const FILTER_KEYS = ['content', 'channel', 'direction', 'last', 'session', 'attrs']
const GATE_AGGS = ['count', 'distinct_sessions', 'sum_dwell_ms', 'sum', 'recency_days']
const GROUP_AGGS = ['count', 'distinct_sessions', 'distinct_passports', 'sum_dwell_ms', 'sum']

// The session columns reachable via exposures.session_id → whitebox_sessions. A
// FIXED ALLOWLIST — safe to reference a column by name; values are always bound.
const SESSION_COLS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'referrer']
function sessionCol(col) {
  if (!SESSION_COLS.includes(col)) throw new Error(`selector.metric: unknown session column "${col}" (allowed: ${SESSION_COLS.join('/')})`)
  return col
}

function windowMs(w) {
  const m = /^(\d+)\s*(h|d|w)$/.exec(String(w ?? '').trim())
  if (!m) throw new Error(`selector.metric: bad window "${w}" (use 7d, 24h, 2w)`)
  return Number(m[1]) * MS[m[2]]
}

// Split a spec into { filters, agg, bounds }, validating the aggregate against the
// set valid for this mode (gate vs group).
function split(spec, validAggs) {
  const filters = {}
  let agg, bounds
  for (const [k, v] of Object.entries(spec || {})) {
    if (FILTER_KEYS.includes(k)) filters[k] = v
    else if (validAggs.includes(k)) { agg = k; bounds = v || {} }
    else throw new Error(`selector.metric: unknown key "${k}"`)
  }
  if (!agg) throw new Error(`selector.metric: needs one aggregate (${validAggs.join('/')})`)
  return { filters, agg, bounds }
}

// The exposures query, aliased `e`; sessions joined as `s` only when needed (a
// `session:` filter/group). With the join, exposure columns MUST be qualified
// (`e.…`) — whitebox_sessions also has passport_id.
const needsSession = (filters, by) =>
  (filters.session && Object.keys(filters.session).length > 0) ||
  (typeof by === 'string' && by.startsWith('session:'))

function base(db, joinSession) {
  let q = db(`${EXPOSURES} as e`)
  if (joinSession) q = q.leftJoin(`${SESSIONS} as s`, 's.id', 'e.session_id')
  return q
}

// Apply the shared event filters to a knex query (all exposure cols qualified `e.`).
function applyFilters(db, q, { content, channel, direction, last, session, attrs }, { at, scope, now }) {
  if (scope?.length) q = q.whereIn('e.passport_id', scope)
  if (content && content !== '*') q = q.whereILike('e.content_id', `%${content}%`)   // DEPRECATED — do not extend
  if (channel) q = q.where('e.channel', channel)
  if (direction) q = q.where('e.direction', direction)
  if (at) q = q.where('e.ts', '<=', now)                                    // as-of: ignore the future
  if (last) q = q.where('e.ts', '>=', new Date(now.getTime() - windowMs(last)))   // lookback window

  // Session-joined typed dimensions (allowlisted column name, bound value).
  for (const [col, val] of Object.entries(session || {})) {
    const c = `s.${sessionCol(col)}`
    q = Array.isArray(val) ? q.whereIn(c, val) : q.where(c, val)
  }

  // Open per-event dims in `meta` jsonb — key AND value are bind params (injection-safe).
  for (const [key, cond] of Object.entries(attrs || {})) {
    const lhs = db.raw('e.meta ->> ?', [key])
    if (Array.isArray(cond)) q = q.whereIn(lhs, cond.map(String))
    else if (cond && typeof cond === 'object') {
      if (cond.present === true) q = q.whereRaw('jsonb_exists(e.meta, ?)', [key])   // not `meta ? k` — `?` collides with knex binds
      else if (Array.isArray(cond.in)) q = q.whereIn(lhs, cond.in.map(String))
      else throw new Error(`selector.metric: attr "${key}" needs a value, { in: [...] }, or { present: true }`)
    } else q = q.where(lhs, String(cond))
  }
  return q
}

// ── the gate (filter.metric) — passports whose aggregate satisfies the bound ──
export async function evaluate(db, spec, { at, scope } = {}) {
  const { filters, agg, bounds } = split(spec, GATE_AGGS)
  const { field, gte, lte } = bounds
  const now = at ? new Date(at) : new Date()

  let q = applyFilters(db, base(db, needsSession(filters)), filters, { at, scope, now })
  q = q.groupBy('e.passport_id').select('e.passport_id as passport_id')

  if (agg === 'recency_days') {
    // recency = days since the most recent matching exposure, relative to `now`.
    if (gte != null) q = q.havingRaw('max(e.ts) <= ?', [new Date(now.getTime() - gte * MS.d)])  // gone quiet ≥ N days
    if (lte != null) q = q.havingRaw('max(e.ts) >= ?', [new Date(now.getTime() - lte * MS.d)])  // active within N days
  } else {
    if (agg === 'sum' && !field) throw new Error('selector.metric: `sum` needs a `field`')
    const expr = {
      count: 'count(*)',
      distinct_sessions: 'count(distinct e.session_id)',
      sum_dwell_ms: 'coalesce(sum(e.dwell_ms), 0)',
      sum: 'coalesce(sum((e.meta->>?)::numeric), 0)',   // sums meta.<field>; currency-naive (see spec)
    }[agg]
    const fp = agg === 'sum' ? [field] : []
    if (gte != null) q = q.havingRaw(`${expr} >= ?`, [...fp, gte])
    if (lte != null) q = q.havingRaw(`${expr} <= ?`, [...fp, lte])
  }

  return (await q).map(r => r.passport_id)
}

// ── the chart (group) — total aggregate bucketed by time grain or dimension ──
const TIME_FMT = { hour: 'YYYY-MM-DD"T"HH24:00', day: 'YYYY-MM-DD', week: 'IYYY"-W"IW', month: 'YYYY-MM' }
const DIM_COL = { channel: 'e.channel', direction: 'e.direction', source: 'e.source', content: 'e.content_id' }

// A bucket → { sql, binds }. Time grains (to_char of ts) and exposure/session
// columns carry no binds (allowlisted names); `attr:<key>` binds the key.
//   "day" | "channel" | "session:utm_campaign" | "attr:event"
function bucketSql(by) {
  if (TIME_FMT[by]) return { sql: `to_char(e.ts, '${TIME_FMT[by]}')`, binds: [] }
  if (DIM_COL[by]) return { sql: DIM_COL[by], binds: [] }            // `content` here is DEPRECATED (opaque id)
  if (typeof by === 'string' && by.startsWith('session:')) return { sql: `s.${sessionCol(by.slice(8))}`, binds: [] }
  if (typeof by === 'string' && by.startsWith('attr:')) return { sql: 'e.meta ->> ?', binds: [by.slice(5)] }
  throw new Error(`selector.group: unknown bucket "${by}" (time: ${Object.keys(TIME_FMT).join('/')}; column: ${Object.keys(DIM_COL).join('/')}; session:<utm…>; attr:<key>)`)
}

function aggSql(agg, field) {
  switch (agg) {
    case 'count': return { sql: 'count(*)', bindings: [] }
    case 'distinct_sessions': return { sql: 'count(distinct e.session_id)', bindings: [] }
    case 'distinct_passports': return { sql: 'count(distinct e.passport_id)', bindings: [] }
    case 'sum_dwell_ms': return { sql: 'coalesce(sum(e.dwell_ms), 0)', bindings: [] }
    case 'sum':
      if (!field) throw new Error('selector.group: `sum` needs a `field`')
      return { sql: 'coalesce(sum((e.meta->>?)::numeric), 0)', bindings: [field] }
    default: throw new Error(`selector.group: aggregate "${agg}" not supported for grouping`)
  }
}

// group(db, spec, { by, at, scope, limit }) → [{ bucket, value }].
// Default: ordered by bucket (chronological for time grains). `limit` is the
// HIGH-CARDINALITY GUARDRAIL — an open key (attr:<key>, session:<utm>) can have
// thousands of buckets, so `limit` returns the top-N by value (desc) instead.
export async function group(db, spec, { by, at, scope, limit } = {}) {
  if (!by) throw new Error('selector.group: needs `by` (a time grain, column, session:<utm>, or attr:<key>)')
  const { filters, agg, bounds } = split(spec, GROUP_AGGS)
  const now = at ? new Date(at) : new Date()
  const bucket = bucketSql(by)
  const value = aggSql(agg, bounds.field)

  let q = applyFilters(db, base(db, needsSession(filters, by)), filters, { at, scope, now })
    .select(db.raw(`${bucket.sql} as bucket`, bucket.binds), db.raw(`${value.sql} as value`, value.bindings))
    .groupByRaw('1')                                          // group by the bucket (output position)
  q = (limit != null)
    ? q.orderByRaw('2 desc').limit(limit)                     // top-N by value (the guardrail)
    : q.orderByRaw('1')                                       // by bucket (chronological for time grains)

  return (await q).map(r => ({ bucket: r.bucket, value: Number(r.value) }))
}
