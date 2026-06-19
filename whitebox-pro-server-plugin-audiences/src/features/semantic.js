// semantic feature — meaning. Vector-narrow to candidates (population) and pull
// per-passport evidence (recall). The LLM judges over this. See docs/04-evaluator.md.

let awareness

export function init(deps) { awareness = deps.awareness }

// Candidate passports for a rule: who is even near this topic? (cheap, HNSW).
// Returns a Set of passport_ids.
export async function candidates(rule, { similarity, limit }) {
  const hits = await awareness.population({ query: rule.seed, similarity, limit })
  // population() returns chunks resolved to passports; collapse to a unique set.
  return new Set((hits || []).map(h => h.passport_id).filter(Boolean))
}

// Per-passport evidence for the AI judge: the most relevant things this passport
// has been exposed to, near the rule seed.
export async function evidence(rule, passportId, { limit = 10 } = {}) {
  const chunks = await awareness.recall({ passport_id: passportId, query: rule.seed, limit })
  return (chunks || []).map(c => ({
    channel: c.channel, source: c.source, content_id: c.content_id,
    similarity: c.similarity, text: c.chunk_text, ts: c.ts,
  }))
}
