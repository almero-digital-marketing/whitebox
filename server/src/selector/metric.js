// Evaluate a `metric` over the awareness exposure stream. Two modes:
//   · evaluate(db, spec, …) → the passports whose per-passport aggregate satisfies
//                             a bound (the *gate*, used by filter.metric — §5)
//   · group(db, spec, { by }) → the TOTAL aggregate bucketed by a time grain or a
//                             dimension → [{ bucket, value }] (the *chart* — §7)
// Both share the same event filters (content / channel / direction / last window
// + asOf + scope); they differ only in what they GROUP BY and return.
//
//   { metric: { content?, channel?, direction?, last?, <agg>: { gte?, lte?, field? } } }
//
// awareness owns the exposures table; the selector reads it for these.

const EXPOSURES = 'whitebox_awareness_exposures'
const MS = { h: 3600e3, d: 86400e3, w: 604800e3 }
const FILTER_KEYS = ['content', 'channel', 'direction', 'last']
const GATE_AGGS = ['count', 'distinct_sessions', 'sum_dwell_ms', 'sum', 'recency_days']
const GROUP_AGGS = ['count', 'distinct_sessions', 'distinct_passports', 'sum_dwell_ms', 'sum']

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

// Apply the shared event filters to a knex query.
function applyFilters(q, { content, channel, direction, last }, { at, scope, now }) {
  if (scope?.length) q = q.whereIn('passport_id', scope)
  if (content && content !== '*') q = q.whereILike('content_id', `%${content}%`)
  if (channel) q = q.where('channel', channel)
  if (direction) q = q.where('direction', direction)
  if (at) q = q.where('ts', '<=', now)                                    // as-of: ignore the future
  if (last) q = q.where('ts', '>=', new Date(now.getTime() - windowMs(last)))   // lookback window
  return q
}

// ── the gate (filter.metric) — passports whose aggregate satisfies the bound ──
export async function evaluate(db, spec, { at, scope } = {}) {
  const { filters, agg, bounds } = split(spec, GATE_AGGS)
  const { field, gte, lte } = bounds
  const now = at ? new Date(at) : new Date()

  let q = applyFilters(db(EXPOSURES), filters, { at, scope, now })
  q = q.groupBy('passport_id').select('passport_id')

  if (agg === 'recency_days') {
    // recency = days since the most recent matching exposure, relative to `now`.
    if (gte != null) q = q.havingRaw('max(ts) <= ?', [new Date(now.getTime() - gte * MS.d)])  // gone quiet ≥ N days
    if (lte != null) q = q.havingRaw('max(ts) >= ?', [new Date(now.getTime() - lte * MS.d)])  // active within N days
  } else {
    if (agg === 'sum' && !field) throw new Error('selector.metric: `sum` needs a `field`')
    const expr = {
      count: 'count(*)',
      distinct_sessions: 'count(distinct session_id)',
      sum_dwell_ms: 'coalesce(sum(dwell_ms), 0)',
      sum: 'coalesce(sum((meta->>?)::numeric), 0)',   // sums meta.<field>; currency-naive (see spec)
    }[agg]
    const fp = agg === 'sum' ? [field] : []
    if (gte != null) q = q.havingRaw(`${expr} >= ?`, [...fp, gte])
    if (lte != null) q = q.havingRaw(`${expr} <= ?`, [...fp, lte])
  }

  return (await q).map(r => r.passport_id)
}

// ── the chart (group) — total aggregate bucketed by time grain or dimension ──
const TIME_FMT = { hour: 'YYYY-MM-DD"T"HH24:00', day: 'YYYY-MM-DD', week: 'IYYY"-W"IW', month: 'YYYY-MM' }
const DIM_COL = { channel: 'channel', direction: 'direction', source: 'source', content: 'content_id' }

// A bucket is either a time grain (to_char of ts — labels sort chronologically) or
// a categorical column. Allowlisted, so it's safe to inline into raw SQL.
function bucketSql(by) {
  if (TIME_FMT[by]) return `to_char(ts, '${TIME_FMT[by]}')`
  if (DIM_COL[by]) return DIM_COL[by]
  throw new Error(`selector.group: unknown bucket "${by}" (time: ${Object.keys(TIME_FMT).join('/')}; dimension: ${Object.keys(DIM_COL).join('/')})`)
}

function aggSql(agg, field) {
  switch (agg) {
    case 'count': return { sql: 'count(*)', bindings: [] }
    case 'distinct_sessions': return { sql: 'count(distinct session_id)', bindings: [] }
    case 'distinct_passports': return { sql: 'count(distinct passport_id)', bindings: [] }
    case 'sum_dwell_ms': return { sql: 'coalesce(sum(dwell_ms), 0)', bindings: [] }
    case 'sum':
      if (!field) throw new Error('selector.group: `sum` needs a `field`')
      return { sql: 'coalesce(sum((meta->>?)::numeric), 0)', bindings: [field] }
    default: throw new Error(`selector.group: aggregate "${agg}" not supported for grouping`)
  }
}

// group(db, spec, { by, at, scope }) → [{ bucket, value }], ordered by bucket.
export async function group(db, spec, { by, at, scope } = {}) {
  if (!by) throw new Error('selector.group: needs `by` (a time grain or dimension)')
  const { filters, agg, bounds } = split(spec, GROUP_AGGS)
  const now = at ? new Date(at) : new Date()
  const bucket = bucketSql(by)
  const value = aggSql(agg, bounds.field)

  const q = applyFilters(db(EXPOSURES), filters, { at, scope, now })
    .select(db.raw(`${bucket} as bucket`), db.raw(`${value.sql} as value`, value.bindings))
    .groupByRaw(bucket)
    .orderByRaw(bucket)

  return (await q).map(r => ({ bucket: r.bucket, value: Number(r.value) }))
}
