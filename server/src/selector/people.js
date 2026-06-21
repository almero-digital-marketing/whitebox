import * as filter from './filter.js'
import * as judge from './judge.js'
import { rt } from './runtime.js'
import { aboutGate, aboutQuery } from './about.js'

// The `people` projection and its cost `preview`. Both run the same `narrow`
// (scope → about gate → filter), so "what you preview == what gets delivered"
// holds by construction. See docs/selector.md §5–§9.

// people — about gates → filter → judge → ids, each carrying matched_at (§7): the
// deterministic filter's qualifying-event time. Null (omitted) for a judge match
// (no clean event time) — so a judged step can't anchor a windowed funnel step.
export async function resolvePeople(selector, opts) {
  const { candidateIds, timed } = await narrow(selector, opts)

  // `judge` — the LLM predicate, last, on the already-narrowed candidates only
  // (cost is bounded by about + filter). Confirmed survivors carry score + why.
  if (selector.judge) {
    const survivors = await judge.evaluate(candidateIds, selector.judge, {
      ai: rt.ai,
      evidenceFor: id => evidenceFor(id, selector),
      concurrency: rt.defaults.judgeConcurrency,
    })
    return { count: survivors.length, passports: survivors.map(s => ({ id: s.id, why: s.reason, score: s.score })) }
  }

  return { count: candidateIds.length, passports: candidateIds.map(id => withMatchedAt(id, timed.get(id))) }
}

// preview(selector, { projection, scope, asOf }) → cost metadata, NO commitment.
// Runs the same deterministic funnel `resolve` would, then — instead of judging
// everyone — reports the counts and *samples* the judge on ~20 survivors. All
// cheap; the only LLM work is the bounded sample. See docs/selector.md §9 (S4).
export async function preview(selector = {}, opts = {}) {
  const { projection = 'people' } = opts
  if (projection !== 'people') throw new Error(`selector: projection "${projection}" not implemented yet`)

  const { candidateIds, aboutCohort, fullScan } = await narrow(selector, opts)
  const survivors = candidateIds.length      // = exactly the judge-call count of a full run

  const out = {
    projection,
    about: aboutCohort == null ? null : { cohort: aboutCohort },
    filter: { survivors },
    fullScan,                                 // §5 — no anchor ⇒ this scanned everyone
    confirmCap: rt.defaults.confirmCap,
    confirmRequired: survivors > rt.defaults.confirmCap,
    judge: null,
  }

  // Sample the judge on a bounded slice → projected qualifying rate + a few real
  // reasons. No selector.judge ⇒ the deterministic survivors *are* the audience.
  if (selector.judge) {
    const sample = candidateIds.slice(0, Math.min(rt.defaults.previewSample, survivors))
    const matched = await judge.evaluate(sample, selector.judge, {
      ai: rt.ai,
      evidenceFor: id => evidenceFor(id, selector),
      concurrency: rt.defaults.judgeConcurrency,
    })
    const rate = sample.length ? matched.length / sample.length : 0
    out.judge = {
      calls: survivors,                       // a full run makes this many judge calls
      sample: sample.length,
      qualifyingRate: rate,
      projectedMatches: Math.round(rate * survivors),
      reasons: matched.map(m => m.reason).filter(Boolean).slice(0, 3),
      estLatencyMs: Math.ceil(survivors / rt.defaults.judgeConcurrency) * rt.defaults.judgeMsPerCall,
    }
  }
  return out
}

// matched_at is included only when known — a normal people query stays `{ id }`;
// a deterministic (fact-anchored) one carries `{ id, matched_at }` for funnels.
function withMatchedAt(id, at) {
  return at != null ? { id, matched_at: at } : { id }
}

// The shared deterministic funnel: scope → about (semantic gate) → filter (the
// boolean tree). Both resolvePeople and preview run exactly this, so they can
// never disagree about who the judge sees. Returns the candidate ids plus the
// metadata preview reports (`aboutCohort`, `fullScan`).
export async function narrow(selector, { scope, asOf } = {}) {
  const at = asOf ? new Date(asOf) : null
  let scopeArr = scope == null ? null : [].concat(scope)
  let aboutCohort = null

  // `about` — semantic narrow → candidate gate. Everyone whose memory clears the
  // similarity floor; intersected with any caller scope. Runs first (cheap-ish),
  // narrowing what the filter then has to gate.
  if (selector.about != null) {
    const cands = await aboutGate(selector.about)
    const candSet = new Set(cands)
    scopeArr = scopeArr ? scopeArr.filter(id => candSet.has(id)) : cands
    aboutCohort = scopeArr.length
  }

  // `fullScan` is set iff the filter actually scanned the whole population — i.e.
  // ctx.universe() did a real DB read because there was no scope/about bound and
  // no positive anchor (empty/pure-negative filter). A bounded scan inside an
  // about cohort or caller scope is not a full scan.
  let universeCache
  let fullScan = false
  const ctx = {
    at,
    scope: scopeArr,
    db: rt.db,                   // metric clauses aggregate the awareness exposure stream
    universe: async () => {
      if (scopeArr) return scopeArr
      fullScan = true
      if (!universeCache) {
        rt.logger.warn('selector: full passport scan (filter has no positive anchor)')
        universeCache = (await rt.db('whitebox_passports').select('id')).map(r => r.id)
      }
      return universeCache
    },
  }

  const timed = await filter.evaluateTimed(selector.filter, ctx)
  return { timed, candidateIds: [...timed.keys()], aboutCohort, fullScan }
}

// Evidence handed to the judge for one candidate: the about-recalled chunks
// (or, with no about, recall on the criteria itself).
async function evidenceFor(id, selector) {
  if (!rt.awareness?.recall) return []
  const query = aboutQuery(selector.about) || selector.judge.criteria
  const hits = await rt.awareness.recall({ passport_id: id, query, limit: 10 })
  return Array.isArray(hits) ? hits : (hits?.data || [])
}
