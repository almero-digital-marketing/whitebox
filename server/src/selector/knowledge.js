import * as filter from './filter.js'
import * as metric from './metric.js'
import { rt } from './runtime.js'
import { aboutQuery } from './about.js'

// The `knowledge` projection — ranked evidence (chunks), never prose (prose is
// the /ask layer §7). `about` is the *ranker* here, not a gate. Three shapes:
//   · passport          → recall over one passport's memory, ranked by about
//   · base + about      → about-ranked evidence across the base, intersected with
//                         the deterministic filter cohort if a filter is present
//   · base, no about    → a representative content sample of the base
export async function resolveKnowledge(selector, { scope, passport, asOf, limit } = {}) {
  if (!rt.awareness) throw new Error('selector: knowledge requires the awareness module')
  const lim = limit ?? rt.defaults.knowledgeLimit
  const query = aboutQuery(selector.about)

  // · passport
  if (scope === 'passport' || passport != null) {
    if (passport == null) throw new Error('selector: knowledge `passport` scope needs a `passport` id')
    if (!query) throw new Error('selector: knowledge over a passport needs `about` to rank evidence')
    const rows = await rt.awareness.recall({ passport_id: passport, query, limit: lim })
    return { projection: 'knowledge', scope: 'passport', passport, evidence: asEvidence(rows).slice(0, lim) }
  }

  // · base — the deterministic cohort (filter only; about ranks, never gates here)
  let cohort = null
  if (selector.filter) {
    const at = asOf ? new Date(asOf) : null
    cohort = new Set(await filter.evaluate(selector.filter, baseCtx(at)))
  }

  if (query) {
    const pop = await rt.awareness.population({ query, similarity: rt.defaults.knowledgeSimilarity, limit: rt.defaults.candidateLimit })
    let hits = (pop?.passports || []).flatMap(p => (p.hits || []).map(h => ({ passport_id: p.passport_id, ...h })))
    if (cohort) hits = hits.filter(h => cohort.has(h.passport_id))
    hits.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
    return { projection: 'knowledge', scope: 'base', count: hits.length, evidence: asEvidence(hits).slice(0, lim) }
  }

  // no about → nothing to rank by. A base-wide content sample is the honest
  // fallback; a *filtered* cohort can't be sampled without a ranker (yet).
  if (cohort) throw new Error('selector: knowledge over a filtered cohort needs `about` to rank evidence')
  const rows = await rt.awareness.sampleContent({ limit: lim })
  return { projection: 'knowledge', scope: 'base', evidence: asEvidence(rows).slice(0, lim) }
}

// group(selector, { group, scope, asOf }) → a time-series / breakdown series (§7):
// the `metric` aggregate in selector.filter, bucketed by `group.by` — a time grain
// (hour/day/week/month), an exposure column (channel/direction/source), a session
// dimension (session:utm_campaign), or a meta attribute (attr:event).
// Returns [{ bucket, value }]. Unlike a people resolve this is the TOTAL aggregate,
// optionally restricted to a caller-provided scope (e.g. a cohort's ids), and
// optionally capped to the top-N buckets by value via `group.limit` (the
// high-cardinality guardrail). The one engine capability charts add.
export async function resolveGroup(selector, { group, scope, asOf } = {}) {
  const m = selector?.filter?.metric
  if (!m) throw new Error('selector: `group` requires a single `metric` filter (the aggregate to bucket)')
  const at = asOf ? new Date(asOf) : null
  const scopeArr = scope == null ? null : [].concat(scope)
  return metric.group(rt.db, m, { by: group?.by, limit: group?.limit, at, scope: scopeArr })
}

// A minimal ctx for evaluating a `filter` over the whole base (knowledge cohort).
// scope null ⇒ universe() is a full population read (a positive filter anchor
// avoids it; a pure-negative filter falls back to it — same rule as §5).
function baseCtx(at) {
  let cache
  return {
    at,
    scope: null,
    db: rt.db,
    universe: async () => {
      if (!cache) cache = (await rt.db('whitebox_passports').select('id')).map(r => r.id)
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
