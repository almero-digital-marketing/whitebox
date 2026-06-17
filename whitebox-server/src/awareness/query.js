import * as store from './store.js'

// Dependencies captured once via init() — module-level singletons, no
// wrapping factory closure. Matches the core pattern (passports, sessions, …).
let ai
let logger

export function init(deps) {
  ai = deps.ai
  logger = deps.logger
}

export async function recall({ passport_id, query, limit = 10 }) {
  const [embedding] = await ai.embed([query])
  return store.recallChunks({ passport_id, embedding, limit })
}

export async function population({ query, similarity = 0.75, limit = 1000 }) {
  const [embedding] = await ai.embed([query])
  const matches = await store.populationChunks({ embedding, similarity, limit })

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
