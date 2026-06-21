import { rt } from './runtime.js'

// `about` — the semantic narrow (S1). The one asymmetry in the engine: for the
// *people* projection `about` GATES (a similarity floor → candidate ids, below);
// for *knowledge* it RANKS (orders content, no hard floor — see knowledge.js).
// `aboutQuery` pulls the query text out of either form a caller may pass.

// `about` may be a bare string or `{ query, … }`; pull the query text out.
export function aboutQuery(about) {
  return (typeof about === 'string' ? about : about?.query) || null
}

// `about` as a people gate: a similarity floor over the semantic memory →
// candidate passport ids. `about` may be a string, or `{ query, similarity?, limit? }`.
export async function aboutGate(about) {
  if (!rt.awareness?.population) throw new Error('selector: `about` requires the awareness module (population)')
  const query = aboutQuery(about)
  if (!query) throw new Error('selector: `about` needs a query string')
  const similarity = (typeof about === 'object' ? about.similarity : undefined) ?? rt.defaults.candidateSimilarity
  const limit = (typeof about === 'object' ? about.limit : undefined) ?? rt.defaults.candidateLimit
  const res = await rt.awareness.population({ query, similarity, limit })
  return (res?.passports || []).map(p => p.passport_id)
}
