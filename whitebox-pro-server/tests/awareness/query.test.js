import { describe, it, expect, vi } from 'vitest'
import * as query from '../../src/awareness/query.js'
import * as store from '../../src/awareness/store.js'

// query composes the store module (import * as store). Mock the store module
// so we can assert query forwards the embedded vector correctly, mirroring the
// previous factory test where store was an injected dependency.
vi.mock('../../src/awareness/store.js', () => ({
  init: vi.fn(),
  recallChunks: vi.fn(),
  populationChunks: vi.fn(),
  populationStats: vi.fn(),
  sampleContent: vi.fn(),
}))

function makeQuery({ recallResult, populationResult, embedding } = {}) {
  store.recallChunks.mockReset().mockImplementation(async () => recallResult ?? [])
  store.populationChunks.mockReset().mockImplementation(async () => populationResult ?? [])
  const ai = {
    embed: vi.fn(async () => [embedding ?? [0.1, 0.2, 0.3]]),
  }
  const logger = { warn: vi.fn() }
  query.init({ ai, logger })
  return { query, store, ai }
}

describe('awareness.query', () => {

  it('recall embeds the query and forwards to store', async () => {
    const { query, store, ai } = makeQuery({
      recallResult: [{ id: 1, chunk_text: 'hi', similarity: 0.9 }],
    })

    const hits = await query.recall({ passport_id: 'p1', query: 'pricing', limit: 5 })
    expect(ai.embed).toHaveBeenCalledWith(['pricing'])
    expect(store.recallChunks).toHaveBeenCalledWith({
      passport_id: 'p1',
      embedding: [0.1, 0.2, 0.3],
      limit: 5,
      offset: 0,
      minSimilarity: 0,
    })
    expect(hits).toHaveLength(1)
  })

  it('population groups hits by passport_id', async () => {
    const { query } = makeQuery({
      populationResult: [
        { passport_id: 'p1', chunk_text: 'a', similarity: 0.9 },
        { passport_id: 'p1', chunk_text: 'b', similarity: 0.85 },
        { passport_id: 'p2', chunk_text: 'c', similarity: 0.8 },
      ],
    })

    const result = await query.population({ query: 'spring promotion' })
    expect(result.count).toBe(2)
    expect(result.passports).toHaveLength(2)
    const p1 = result.passports.find(p => p.passport_id === 'p1')
    expect(p1.hits).toHaveLength(2)
  })

  it('population returns empty when no matches', async () => {
    const { query } = makeQuery({ populationResult: [] })
    const result = await query.population({ query: 'xyz' })
    expect(result.count).toBe(0)
    expect(result.passports).toEqual([])
  })

  it('population respects similarity threshold passed through', async () => {
    const { query, store } = makeQuery({ populationResult: [] })
    await query.population({ query: 'x', similarity: 0.9, limit: 50 })
    expect(store.populationChunks).toHaveBeenCalledWith({
      embedding: [0.1, 0.2, 0.3],
      similarity: 0.9,
      limit: 50,
      minEngagement: 0,
    })
  })

  it('population forwards min_engagement as minEngagement', async () => {
    const { query, store } = makeQuery({ populationResult: [] })
    await query.population({ query: 'x', min_engagement: 0.15 })
    expect(store.populationChunks).toHaveBeenCalledWith(expect.objectContaining({ minEngagement: 0.15 }))
  })

  it('populationStats delegates to the store (no embedding)', async () => {
    const { query, store, ai } = makeQuery()
    store.populationStats.mockResolvedValue({ customers: 7, exposures: 30, breakdown: [] })
    const stats = await query.populationStats()
    expect(store.populationStats).toHaveBeenCalled()
    expect(ai.embed).not.toHaveBeenCalled()
    expect(stats.customers).toBe(7)
  })

  it('sampleContent forwards args to the store', async () => {
    const { query, store } = makeQuery()
    store.sampleContent.mockResolvedValue([{ chunk_text: 'x', customers: 3 }])
    const rows = await query.sampleContent({ limit: 20 })
    expect(store.sampleContent).toHaveBeenCalledWith({ limit: 20 })
    expect(rows).toHaveLength(1)
  })
})
