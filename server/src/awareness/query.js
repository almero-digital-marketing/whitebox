import * as store from './store.js'

// Dependencies captured once via init() — module-level singletons, no
// wrapping factory closure. Matches the core pattern (passports, sessions, …).
let ai
let logger

export function init(deps) {
  ai = deps.ai
  logger = deps.logger
}

export async function recall({ passport_id, query, limit = 10, offset = 0, min_similarity = 0 }) {
  const [embedding] = await ai.embed([query])
  return store.recallChunks({ passport_id, embedding, limit, offset, minSimilarity: min_similarity })
}

export async function population({ query, similarity = 0.75, limit = 1000, min_engagement = 0, scope, last, from }) {
  const [embedding] = await ai.embed([query])
  // scope (cohort) + last/from (window) confine recall to a structured cohort and
  // timeframe (docs/scoped-recall.md); both optional, default = whole base/all time.
  const matches = await store.populationChunks({ embedding, similarity, limit, minEngagement: min_engagement, scope, last, from })

  const byPassport = new Map()
  for (const m of matches) {
    if (!byPassport.has(m.passport_id)) {
      byPassport.set(m.passport_id, { passport_id: m.passport_id, hits: [] })
    }
    byPassport.get(m.passport_id).hits.push(m)
  }

  return {
    count: byPassport.size,
    passports: [...byPassport.values()],
  }
}

// Base-wide aggregates + a query-independent content sample. These ground
// population-scope synthesis for overview/aggregate questions ("how many
// customers", "what are people interested in") that map to no semantic cohort.
export async function populationStats({ scope, last, from } = {}) {
  return store.populationStats({ scope, last, from })
}

export async function sampleContent(args = {}) {
  return store.sampleContent(args)
}
