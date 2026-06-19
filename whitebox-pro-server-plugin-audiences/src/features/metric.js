// metric feature — math. Deterministic aggregates over awareness exposures.
// No LLM, no embeddings — just SQL. The LLM never counts; this does.
// See docs/04-evaluator.md.

let db
const EXPOSURES = 'whitebox_awareness_exposures'

export function init(deps) { db = deps.db }

// Compute one metric requirement for a passport → a number.
async function compute(passportId, req) {
  let q = db(EXPOSURES).where({ passport_id: passportId })
  if (req.content) q = q.whereILike('content_id', `%${req.content}%`)
  if (req.channel) q = q.where({ channel: req.channel })

  switch (req.metric) {
    case 'count':             return Number((await q.count('* as n').first()).n)
    case 'distinct_sessions': return Number((await q.countDistinct('session_id as n').first()).n)
    case 'sum_dwell_ms':      return Number((await q.sum('dwell_ms as n').first()).n || 0)
    case 'recency_days': {
      const row = await q.max('ts as t').first()
      if (!row?.t) return Infinity
      return (Date.now() - new Date(row.t).getTime()) / 86_400_000
    }
    default: return 0
  }
}

// Evaluate all metric requirements for a passport. Returns
// { values: {...}, pass: bool } — `pass` is true only if every gte/lte holds.
export async function evaluate(passportId, reqs = []) {
  const values = {}
  let pass = true
  for (const req of reqs) {
    const v = await compute(passportId, req)
    const key = `${req.metric}(${req.content || '*'})`
    values[key] = v
    if (req.gte != null && !(v >= req.gte)) pass = false
    if (req.lte != null && !(v <= req.lte)) pass = false
  }
  return { values, pass }
}
