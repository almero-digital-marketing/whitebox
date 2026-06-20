import * as funnelEngine from './funnel.js'
import { resolvePeople, preview } from './people.js'
import { resolveKnowledge, resolveGroup } from './knowledge.js'

// The selector engine — the public face. `resolve()` dispatches by projection;
// the people and knowledge paths live in their own modules (people.js,
// knowledge.js), the shared injected deps in runtime.js, the semantic narrow in
// about.js, and the deterministic gates in filter.js / metric.js / judge.js.
// Funnels (§14) compose the people path. See docs/selector.md.

export { init } from './runtime.js'
export { preview }

// resolve(selector, opts) → a projection result
//   projection: "people" (ids) | "knowledge" (evidence)
//   scope:      people → passport-id array | undefined (whole base)
//               knowledge → "passport" (with `passport`) | undefined (base)
//   passport:   the passport id, for knowledge·passport scope
//   asOf:       a point in time — applies to the deterministic filter; `about`
//               is a now-relative semantic narrow/rank
//   limit:      knowledge — evidence rows to return
//   group:      { by } — return a time-series / breakdown series instead of a
//               projection (§7); buckets selector.filter.metric by a time grain
//               or dimension
export async function resolve(selector = {}, opts = {}) {
  if (opts.group) return resolveGroup(selector, opts)   // charts — a series, not a projection
  const { projection = 'people' } = opts
  if (projection === 'people') return resolvePeople(selector, opts)
  if (projection === 'knowledge') return resolveKnowledge(selector, opts)
  throw new Error(`selector: projection "${projection}" not implemented yet`)
}

// funnel(spec, { asOf, named }) — ordered windowed steps over the people engine.
// Each step is resolved as a people query scoped to the prior step's survivors,
// joined on matched_at. Returns { report, steps, gaps } (§14). `funnelSlot` turns
// a result + slot name into an audience cohort.
export async function funnel(spec, { asOf, named } = {}) {
  return funnelEngine.run(spec, {
    asOf,
    named,
    resolveStep: (sel, { scope }) => resolvePeople(sel, { projection: 'people', scope, asOf }),
  })
}
export const funnelSlot = funnelEngine.slot
