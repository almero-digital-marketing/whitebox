import * as filter from './filter.js'
import * as judge from './judge.js'

// The selector engine — resolve a `{ about, filter, judge }` predicate into a
// projection. See docs/selector.md.
//
// So far: the `people` projection, with `about` (semantic narrow → candidate
// gate) → `filter` (the deterministic boolean tree of fact + metric clauses).
// `judge` (LLM predicate), the `knowledge` projection, preview() and funnels
// land in later increments.

let db
let logger
let passports        // reserved: scope/merge resolution as the engine grows
let awareness        // injected — the semantic memory (about → population, judge evidence → recall)
let ai               // injected — the LLM behind judge
let defaults

export function init(deps) {
  db = deps.db
  passports = deps.passports
  awareness = deps.awareness
  ai = deps.ai
  logger = deps.logger.child({ component: 'selector' })
  defaults = {
    candidateSimilarity: deps.config?.selector?.candidateSimilarity ?? 0.72,
    candidateLimit: deps.config?.selector?.candidateLimit ?? 2000,
  }
}

// resolve(selector, { projection, scope, asOf }) → result
//   projection: "people"           (knowledge comes later)
//   scope:      array of passport ids | undefined (whole base)
//   asOf:       a point in time     (applies to the deterministic filter; `about`
//               is a now-relative semantic narrow)
export async function resolve(selector = {}, { projection = 'people', scope, asOf } = {}) {
  if (projection !== 'people') throw new Error(`selector: projection "${projection}" not implemented yet`)

  const at = asOf ? new Date(asOf) : null
  let scopeArr = scope == null ? null : [].concat(scope)

  // `about` — semantic narrow → candidate gate. Everyone whose memory clears the
  // similarity floor; intersected with any caller scope. Runs first (cheap-ish),
  // narrowing what the filter then has to gate.
  if (selector.about != null) {
    const cands = await aboutGate(selector.about)
    const candSet = new Set(cands)
    scopeArr = scopeArr ? scopeArr.filter(id => candSet.has(id)) : cands
  }

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

  const candidateIds = await filter.evaluate(selector.filter, ctx)

  // `judge` — the LLM predicate, last, on the already-narrowed candidates only
  // (cost is bounded by about + filter). Confirmed survivors carry score + why.
  if (selector.judge) {
    const survivors = await judge.evaluate(candidateIds, selector.judge, {
      ai,
      evidenceFor: id => evidenceFor(id, selector),
    })
    return { count: survivors.length, passports: survivors.map(s => ({ id: s.id, why: s.reason, score: s.score })) }
  }

  return { count: candidateIds.length, passports: candidateIds.map(id => ({ id })) }   // matched_at (funnels) lands later
}

// Evidence handed to the judge for one candidate: the about-recalled chunks
// (or, with no about, recall on the criteria itself).
async function evidenceFor(id, selector) {
  if (!awareness?.recall) return []
  const about = selector.about
  const query = (typeof about === 'string' ? about : about?.query) || selector.judge.criteria
  const hits = await awareness.recall({ passport_id: id, query, limit: 10 })
  return Array.isArray(hits) ? hits : (hits?.data || [])
}

// `about` as a people gate: a similarity floor over the semantic memory →
// candidate passport ids. `about` may be a string, or `{ query, similarity?, limit? }`.
async function aboutGate(about) {
  if (!awareness?.population) throw new Error('selector: `about` requires the awareness module (population)')
  const query = typeof about === 'string' ? about : about?.query
  if (!query) throw new Error('selector: `about` needs a query string')
  const similarity = (typeof about === 'object' ? about.similarity : undefined) ?? defaults.candidateSimilarity
  const limit = (typeof about === 'object' ? about.limit : undefined) ?? defaults.candidateLimit
  const res = await awareness.population({ query, similarity, limit })
  return (res?.passports || []).map(p => p.passport_id)
}
