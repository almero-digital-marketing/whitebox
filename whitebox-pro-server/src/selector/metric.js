// Evaluate a `metric` filter clause — a windowed aggregate over the awareness
// exposure stream → the passports whose aggregate satisfies the bound. This is
// the *event* half of the filter (the `fact` half is structured memory). See
// docs/selector.md §5.
//
//   { metric: { content?, channel?, direction?, last?, <agg>: { gte?, lte?, field? } } }
//   <agg> ∈ count | distinct_sessions | sum_dwell_ms | sum | recency_days
//   last  — the lookback window (a past window; e.g. "2 pricing visits in the last 30d")
//
// awareness owns the exposures table; the selector reads it for these gates.

const EXPOSURES = 'whitebox_awareness_exposures'
const MS = { h: 3600e3, d: 86400e3, w: 604800e3 }
const FILTER_KEYS = ['content', 'channel', 'direction', 'last']
const AGGS = ['count', 'distinct_sessions', 'sum_dwell_ms', 'sum', 'recency_days']

function windowMs(w) {
  const m = /^(\d+)\s*(h|d|w)$/.exec(String(w ?? '').trim())
  if (!m) throw new Error(`selector.metric: bad window "${w}" (use 7d, 24h, 2w)`)
  return Number(m[1]) * MS[m[2]]
}

function parse(spec) {
  const f = {}
  let agg, bounds
  for (const [k, v] of Object.entries(spec || {})) {
    if (FILTER_KEYS.includes(k)) f[k] = v
    else if (AGGS.includes(k)) { agg = k; bounds = v || {} }
    else throw new Error(`selector.metric: unknown key "${k}"`)
  }
  if (!agg) throw new Error(`selector.metric: needs one aggregate (${AGGS.join('/')})`)
  return { ...f, agg, ...bounds }
}

export async function evaluate(db, spec, { at, scope } = {}) {
  const { content, channel, direction, last, agg, field, gte, lte } = parse(spec)
  const now = at ? new Date(at) : new Date()

  let q = db(EXPOSURES)
  if (scope?.length) q = q.whereIn('passport_id', scope)
  if (content && content !== '*') q = q.whereILike('content_id', `%${content}%`)
  if (channel) q = q.where('channel', channel)
  if (direction) q = q.where('direction', direction)
  if (at) q = q.where('ts', '<=', now)                                    // as-of: ignore the future
  if (last) q = q.where('ts', '>=', new Date(now.getTime() - windowMs(last)))   // lookback window
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
