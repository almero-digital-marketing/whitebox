import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import knex from 'knex'
import crypto from 'crypto'

import * as store from '../../src/awareness/store.js'

// Real-DB verification that the population path confines recall + grounding stats
// to a passport cohort (scope) and a time window (last/from) — docs/scoped-recall.md.
const db = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 5 } })
const VEC = Array(1536).fill(0.1)                       // a fixed query/chunk embedding
const vecLit = `[${VEC.join(',')}]`
const recent = new Date(Date.now() - 5 * 86400e3)       // within 30d
const old = new Date(Date.now() - 200 * 86400e3)        // outside 30d  (dates are relative → time-robust)

beforeAll(() => { store.init({ db }) })
afterAll(async () => { await db.destroy() })
beforeEach(async () => {
  await db.raw('TRUNCATE TABLE whitebox_awareness_chunks, whitebox_awareness_exposures, whitebox_passports CASCADE')
})

async function newPassport() { const id = crypto.randomUUID(); await db('whitebox_passports').insert({ id }); return id }
async function chunk(content_hash, text = 'topic') {
  await db('whitebox_awareness_chunks').insert({ content_hash, chunk_index: 0, chunk_text: text, embedding: vecLit })
}
async function expose(passport_id, { ts, content_hash = null, channel = 'web', direction = 'exposure' }) {
  await db('whitebox_awareness_exposures').insert({ passport_id, ts, channel, direction, text: 'x', content_hash })
}

describe('awareness.populationStats — scope + window confinement', () => {
  let p1, p2, p3
  beforeEach(async () => {
    p1 = await newPassport(); p2 = await newPassport(); p3 = await newPassport()
    await expose(p1, { ts: recent }); await expose(p1, { ts: old })   // p1: one recent + one old
    await expose(p2, { ts: recent })
    await expose(p3, { ts: recent })
  })

  it('default = whole base, all time', async () => {
    const s = await store.populationStats()
    expect(s.customers).toBe(3)
    expect(s.exposures).toBe(4)
  })

  it('scope confines the aggregates to the cohort', async () => {
    const s = await store.populationStats({ scope: [p1] })
    expect(s.customers).toBe(1)
    expect(s.exposures).toBe(2)              // both of p1's events, regardless of time
  })

  it('a window drops events outside it', async () => {
    const s = await store.populationStats({ last: '30d' })
    expect(s.customers).toBe(3)              // p1/p2/p3 all have a recent event
    expect(s.exposures).toBe(3)              // p1's OLD event excluded
  })

  it('scope + window combine', async () => {
    const s = await store.populationStats({ scope: [p1], last: '30d' })
    expect(s.customers).toBe(1)
    expect(s.exposures).toBe(1)              // p1's recent event only
  })
})

describe('awareness.populationChunks — scope + window confinement', () => {
  let p1, p2
  beforeEach(async () => {
    p1 = await newPassport(); p2 = await newPassport()
    await chunk('H')
    await expose(p1, { ts: recent, content_hash: 'H' })
    await expose(p1, { ts: old, content_hash: 'H' })
    await expose(p2, { ts: recent, content_hash: 'H' })
  })

  it('default returns matches across the whole base', async () => {
    const rows = await store.populationChunks({ embedding: VEC, similarity: 0.5, limit: 100 })
    expect(new Set(rows.map(r => r.passport_id))).toEqual(new Set([p1, p2]))
  })

  it('scope confines recall to the cohort', async () => {
    const rows = await store.populationChunks({ embedding: VEC, similarity: 0.5, limit: 100, scope: [p1] })
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(r => r.passport_id === p1)).toBe(true)   // p2 excluded
  })

  it('a window confines recall to recent activity', async () => {
    const rows = await store.populationChunks({ embedding: VEC, similarity: 0.5, limit: 100, last: '30d' })
    expect(rows.every(r => new Date(r.ts) >= new Date(Date.now() - 31 * 86400e3))).toBe(true)
    expect(new Set(rows.map(r => r.passport_id))).toEqual(new Set([p1, p2]))   // both have recent events
  })

  it('scope + window → just that cohort’s recent matches', async () => {
    const rows = await store.populationChunks({ embedding: VEC, similarity: 0.5, limit: 100, scope: [p1], last: '30d' })
    expect(rows).toHaveLength(1)
    expect(rows[0].passport_id).toBe(p1)
  })
})

describe('awareness.sampleContent — scope confinement', () => {
  it('reach reflects only the scoped cohort', async () => {
    const p1 = await newPassport(), p2 = await newPassport(), p3 = await newPassport()
    await chunk('H')
    for (const p of [p1, p2, p3]) await expose(p, { ts: recent, content_hash: 'H' })

    const all = await store.sampleContent({ limit: 10 })
    expect(Number(all[0].customers)).toBe(3)                          // base-wide reach

    const scoped = await store.sampleContent({ limit: 10, scope: [p1] })
    expect(Number(scoped[0].customers)).toBe(1)                       // only the cohort counts
  })
})
