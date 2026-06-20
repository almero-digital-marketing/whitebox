import * as filter from './filter.js'

// The selector engine — resolve a `{ about, filter, judge }` predicate into a
// projection. See docs/selector.md.
//
// Increment 1: the `people` projection over a `filter` of `fact` clauses (the
// deterministic, no-LLM path). `about` (semantic narrow), `judge` (LLM
// predicate), `metric` clauses, the `knowledge` projection, preview() and
// funnels land in later increments.

let db
let logger
let passports   // reserved: scope/merge resolution as the engine grows

export function init(deps) {
  db = deps.db
  passports = deps.passports
  logger = deps.logger.child({ component: 'selector' })
}

// resolve(selector, { projection, scope, asOf }) → result
//   projection: "people"           (knowledge comes later)
//   scope:      array of passport ids | undefined (whole base)
//   asOf:       a point in time
export async function resolve(selector = {}, { projection = 'people', scope, asOf } = {}) {
  if (projection !== 'people') throw new Error(`selector: projection "${projection}" not implemented yet`)
  if (selector.about || selector.judge) throw new Error('selector: about / judge not implemented yet')

  const at = asOf ? new Date(asOf) : null
  const scopeArr = scope == null ? null : [].concat(scope)

  // The candidate universe: the given scope, or — only when a clause genuinely
  // needs it (a pure-negative filter) — every passport, materialized once and
  // flagged as a full scan (§5 / S3).
  let universeCache
  const ctx = {
    at,
    scope: scopeArr,
    db,                          // metric clauses aggregate the awareness exposure stream
    universe: async () => {
      if (scopeArr) return scopeArr
      if (!universeCache) {
        logger.warn('selector: full passport scan (filter has no positive anchor)')
        universeCache = (await db('whitebox_passports').select('id')).map(r => r.id)
      }
      return universeCache
    },
  }

  const ids = await filter.evaluate(selector.filter, ctx)
  return { count: ids.length, passports: ids.map(id => ({ id })) }   // matched_at (funnels) lands later
}
