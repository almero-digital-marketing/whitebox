import * as filter from './filter.js'
import * as judge from './judge.js'
import * as funnelEngine from './funnel.js'

// The selector engine — resolve a `{ about, filter, judge }` predicate into a
// projection. See docs/selector.md.
//
// Projections (§7): `people` returns ids (about gates → filter → judge), and
// `knowledge` returns ranked evidence (chunks) — same selector, different thing
// asked back. The one asymmetry is `about` (S1): it *gates* for people (a
// similarity floor) but *ranks* for knowledge (orders content, no hard floor).
// `preview()` makes the judge's cost visible before you run/save (§9). Funnels
// and time-series `group` land in later increments.

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
  const cfg = deps.config?.selector ?? {}
  defaults = {
    candidateSimilarity: cfg.candidateSimilarity ?? 0.72,
    candidateLimit: cfg.candidateLimit ?? 2000,
    previewSample: cfg.previewSample ?? 20,      // §9 — judge sample size for preview
    confirmCap: cfg.confirmCap ?? 5000,          // §9 — survivors above this need explicit confirm
    judgeConcurrency: cfg.judgeConcurrency ?? 6, // matches judge.evaluate's default
    judgeMsPerCall: cfg.judgeMsPerCall ?? 1200,  // coarse per-call latency for the estimate
    knowledgeLimit: cfg.knowledgeLimit ?? 20,    // §7 — evidence rows returned by the knowledge projection
    knowledgeSimilarity: cfg.knowledgeSimilarity ?? 0.3, // soft relevance floor — about *ranks* knowledge (S1)
  }
}

// resolve(selector, opts) → a projection result
//   projection: "people" (ids) | "knowledge" (evidence)
//   scope:      people → passport-id array | undefined (whole base)
//               knowledge → "passport" (with `passport`) | undefined (base)
//   passport:   the passport id, for knowledge·passport scope
//   asOf:       a point in time — applies to the deterministic filter; `about`
//               is a now-relative semantic narrow/rank
//   limit:      knowledge — evidence rows to return
export async function resolve(selector = {}, opts = {}) {
  const { projection = 'people' } = opts
  if (projection === 'people') return resolvePeople(selector, opts)
  if (projection === 'knowledge') return resolveKnowledge(selector, opts)
  throw new Error(`selector: projection "${projection}" not implemented yet`)
}

// people — about gates → filter → judge → ids, each carrying matched_at (§7): the
// deterministic filter's qualifying-event time. Null (omitted) for a judge match
// (no clean event time) — so a judged step can't anchor a windowed funnel step.
async function resolvePeople(selector, opts) {
  const { candidateIds, timed } = await narrow(selector, opts)

  // `judge` — the LLM predicate, last, on the already-narrowed candidates only
  // (cost is bounded by about + filter). Confirmed survivors carry score + why.
  if (selector.judge) {
    const survivors = await judge.evaluate(candidateIds, selector.judge, {
      ai,
      evidenceFor: id => evidenceFor(id, selector),
      concurrency: defaults.judgeConcurrency,
    })
    return { count: survivors.length, passports: survivors.map(s => ({ id: s.id, why: s.reason, score: s.score })) }
  }

  return { count: candidateIds.length, passports: candidateIds.map(id => withMatchedAt(id, timed.get(id))) }
}

// matched_at is included only when known — a normal people query stays `{ id }`;
// a deterministic (fact-anchored) one carries `{ id, matched_at }` for funnels.
function withMatchedAt(id, at) {
  return at != null ? { id, matched_at: at } : { id }
}

// funnel(spec, { asOf, named }) — ordered windowed steps over the people engine.
// Each step is resolved as a people query scoped to the prior step's survivors,
// joined on matched_at. Returns { report, steps, gaps } (§14). `slot()` (re-
// exported as funnelSlot) turns a result + slot name into an audience cohort.
export async function funnel(spec, { asOf, named } = {}) {
  return funnelEngine.run(spec, {
    asOf,
    named,
    resolveStep: (sel, { scope }) => resolvePeople(sel, { projection: 'people', scope, asOf }),
  })
}
export const funnelSlot = funnelEngine.slot

// knowledge — ranked evidence (chunks), never prose (prose is the /ask layer §7).
// `about` is the *ranker* here, not a gate. Three shapes:
//   · passport          → recall over one passport's memory, ranked by about
//   · base + about      → about-ranked evidence across the base, intersected with
//                         the deterministic filter cohort if a filter is present
//   · base, no about    → a representative content sample of the base
async function resolveKnowledge(selector, { scope, passport, asOf, limit } = {}) {
  if (!awareness) throw new Error('selector: knowledge requires the awareness module')
  const lim = limit ?? defaults.knowledgeLimit
  const query = aboutQuery(selector.about)

  // · passport
  if (scope === 'passport' || passport != null) {
    if (passport == null) throw new Error('selector: knowledge `passport` scope needs a `passport` id')
    if (!query) throw new Error('selector: knowledge over a passport needs `about` to rank evidence')
    const rows = await awareness.recall({ passport_id: passport, query, limit: lim })
    return { projection: 'knowledge', scope: 'passport', passport, evidence: asEvidence(rows).slice(0, lim) }
  }

  // · base — the deterministic cohort (filter only; about ranks, never gates here)
  let cohort = null
  if (selector.filter) {
    const at = asOf ? new Date(asOf) : null
    cohort = new Set(await filter.evaluate(selector.filter, baseCtx(at)))
  }

  if (query) {
    const pop = await awareness.population({ query, similarity: defaults.knowledgeSimilarity, limit: defaults.candidateLimit })
    let hits = (pop?.passports || []).flatMap(p => (p.hits || []).map(h => ({ passport_id: p.passport_id, ...h })))
    if (cohort) hits = hits.filter(h => cohort.has(h.passport_id))
    hits.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
    return { projection: 'knowledge', scope: 'base', count: hits.length, evidence: asEvidence(hits).slice(0, lim) }
  }

  // no about → nothing to rank by. A base-wide content sample is the honest
  // fallback; a *filtered* cohort can't be sampled without a ranker (yet).
  if (cohort) throw new Error('selector: knowledge over a filtered cohort needs `about` to rank evidence')
  const rows = await awareness.sampleContent({ limit: lim })
  return { projection: 'knowledge', scope: 'base', evidence: asEvidence(rows).slice(0, lim) }
}

// preview(selector, { projection, scope, asOf }) → cost metadata, NO commitment.
// Runs the same deterministic funnel `resolve` would (so "what you preview == what
// gets delivered" by construction), then — instead of judging everyone — reports
// the counts and *samples* the judge on ~20 survivors. All cheap; the only LLM
// work is the bounded sample. See docs/selector.md §9 (S4).
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
    confirmCap: defaults.confirmCap,
    confirmRequired: survivors > defaults.confirmCap,
    judge: null,
  }

  // Sample the judge on a bounded slice → projected qualifying rate + a few real
  // reasons. No selector.judge ⇒ the deterministic survivors *are* the audience.
  if (selector.judge) {
    const sample = candidateIds.slice(0, Math.min(defaults.previewSample, survivors))
    const matched = await judge.evaluate(sample, selector.judge, {
      ai,
      evidenceFor: id => evidenceFor(id, selector),
      concurrency: defaults.judgeConcurrency,
    })
    const rate = sample.length ? matched.length / sample.length : 0
    out.judge = {
      calls: survivors,                       // a full run makes this many judge calls
      sample: sample.length,
      qualifyingRate: rate,
      projectedMatches: Math.round(rate * survivors),
      reasons: matched.map(m => m.reason).filter(Boolean).slice(0, 3),
      estLatencyMs: Math.ceil(survivors / defaults.judgeConcurrency) * defaults.judgeMsPerCall,
    }
  }
  return out
}

// The shared deterministic funnel: scope → about (semantic gate) → filter (the
// boolean tree). Both resolve and preview run exactly this, so they can never
// disagree about who the judge sees. Returns the candidate ids plus the metadata
// preview reports (`aboutCohort`, `fullScan`).
async function narrow(selector, { scope, asOf } = {}) {
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
    db,                          // metric clauses aggregate the awareness exposure stream
    universe: async () => {
      if (scopeArr) return scopeArr
      fullScan = true
      if (!universeCache) {
        logger.warn('selector: full passport scan (filter has no positive anchor)')
        universeCache = (await db('whitebox_passports').select('id')).map(r => r.id)
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
  const query = aboutQuery(about)
  if (!query) throw new Error('selector: `about` needs a query string')
  const similarity = (typeof about === 'object' ? about.similarity : undefined) ?? defaults.candidateSimilarity
  const limit = (typeof about === 'object' ? about.limit : undefined) ?? defaults.candidateLimit
  const res = await awareness.population({ query, similarity, limit })
  return (res?.passports || []).map(p => p.passport_id)
}

// `about` may be a bare string or `{ query, … }`; pull the query text out.
function aboutQuery(about) {
  return (typeof about === 'string' ? about : about?.query) || null
}

// A minimal ctx for evaluating a `filter` over the whole base (knowledge cohort).
// scope null ⇒ universe() is a full population read (a positive filter anchor
// avoids it; a pure-negative filter falls back to it — same rule as §5).
function baseCtx(at) {
  let cache
  return {
    at,
    scope: null,
    db,
    universe: async () => {
      if (!cache) cache = (await db('whitebox_passports').select('id')).map(r => r.id)
      return cache
    },
  }
}

// Normalize a memory chunk (recall / population / sampleContent all differ
// slightly) into one evidence shape, dropping absent fields.
function asEvidence(rows) {
  return (rows || []).map(r => prune({
    passport_id: r.passport_id,
    channel: r.channel,
    direction: r.direction,
    content: r.chunk_text ?? r.content ?? r.text,
    similarity: r.similarity,
    observed_at: r.ts ?? r.observed_at,
    source: r.source,
    reach: r.customers,                 // sampleContent: how many people the content reached
  }))
}

const prune = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null))
