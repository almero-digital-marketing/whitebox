import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import knex from 'knex'
import crypto from 'crypto'

import * as facts from '../../src/facts/index.js'
import * as selector from '../../src/selector/index.js'

const db = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 5 } })
const passports = { resolve: async id => id }
const logger = { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }
const d = s => new Date(s)
const texts = res => res.evidence.map(e => e.content)

// awareness stub — the three reads the knowledge projection uses. recall is keyed
// by passport; population returns passports-with-hits per query; sampleContent is
// the base-wide fallback.
let recallMap = {}
let popMap = {}
let sampleRows = []
let lastPopArgs = null
const awareness = {
  recall: async ({ passport_id }) => recallMap[passport_id] || [],
  population: async (args) => { lastPopArgs = args; return { passports: popMap[args.query] || [] } },
  sampleContent: async () => sampleRows,
}

beforeAll(async () => {
  facts.init({ db, passports, logger })
  await facts.migrate()
  selector.init({ db, passports, logger, awareness, ai: {}, config: { selector: { knowledgeLimit: 5 } } })
})
afterAll(async () => { await db.destroy() })
beforeEach(async () => {
  recallMap = {}; popMap = {}; sampleRows = []; lastPopArgs = null
  await db.raw('TRUNCATE TABLE whitebox_facts, whitebox_passports CASCADE')
})

async function newPassport() { const id = crypto.randomUUID(); await db('whitebox_passports').insert({ id }); return id }
async function proFree() {
  const a = await newPassport(), b = await newPassport()
  const at = d('2026-04-10')
  await facts.record({ passport_id: a, key: 'plan_tier', value: 'pro', observed_at: at })
  await facts.record({ passport_id: b, key: 'plan_tier', value: 'free', observed_at: at })
  return { a, b }
}

describe('selector knowledge (ranked evidence)', () => {
  it('passport scope recalls one passport, ranked by about', async () => {
    const { a } = await proFree()
    recallMap[a] = [
      { chunk_text: 'asked about pricing', channel: 'web', direction: 'expression', similarity: 0.9, ts: d('2026-05-01') },
      { chunk_text: 'opened plans page', channel: 'web', direction: 'exposure', similarity: 0.7, ts: d('2026-05-02') },
    ]
    const res = await selector.resolve({ about: 'pricing' }, { projection: 'knowledge', scope: 'passport', passport: a })
    expect(res).toMatchObject({ projection: 'knowledge', scope: 'passport', passport: a })
    expect(texts(res)).toEqual(['asked about pricing', 'opened plans page'])
    expect(res.evidence[0]).toMatchObject({ content: 'asked about pricing', channel: 'web', similarity: 0.9 })
  })

  it('base + about ranks evidence across the base by similarity', async () => {
    const { a, b } = await proFree()
    popMap['whitening'] = [
      { passport_id: a, hits: [{ chunk_text: 'low relevance', similarity: 0.4, channel: 'web', direction: 'exposure' }] },
      { passport_id: b, hits: [{ chunk_text: 'high relevance', similarity: 0.95, channel: 'web', direction: 'expression' }] },
    ]
    const res = await selector.resolve({ about: 'whitening' }, { projection: 'knowledge' })
    expect(res).toMatchObject({ projection: 'knowledge', scope: 'base', count: 2 })
    expect(texts(res)).toEqual(['high relevance', 'low relevance'])   // sorted by similarity desc
    expect(lastPopArgs).toMatchObject({ query: 'whitening', similarity: 0.3 })  // about *ranks* (soft floor)
  })

  it('base + about + filter keeps only the cohort’s evidence', async () => {
    const { a, b } = await proFree()
    popMap['x'] = [
      { passport_id: a, hits: [{ chunk_text: 'from pro', similarity: 0.8 }] },
      { passport_id: b, hits: [{ chunk_text: 'from free', similarity: 0.9 }] },
    ]
    const res = await selector.resolve(
      { about: 'x', filter: { fact: { plan_tier: { eq: 'pro' } } } },
      { projection: 'knowledge' })
    expect(texts(res)).toEqual(['from pro'])   // b (free) filtered out despite higher similarity
    expect(res.count).toBe(1)
  })

  it('base with no about returns a representative content sample', async () => {
    await proFree()
    sampleRows = [
      { chunk_text: 'most-seen post', customers: 42, channel: 'email', direction: 'exposure', ts: d('2026-05-01') },
    ]
    const res = await selector.resolve({}, { projection: 'knowledge' })
    expect(res).toMatchObject({ projection: 'knowledge', scope: 'base' })
    expect(res.evidence[0]).toMatchObject({ content: 'most-seen post', reach: 42 })
  })

  it('honours the limit', async () => {
    const { a } = await proFree()
    recallMap[a] = Array.from({ length: 10 }, (_, i) => ({ chunk_text: `c${i}`, similarity: 1 - i / 10 }))
    const res = await selector.resolve({ about: 'x' }, { projection: 'knowledge', scope: 'passport', passport: a, limit: 3 })
    expect(res.evidence).toHaveLength(3)
  })

  it('a filtered cohort with no about errors (nothing to rank by)', async () => {
    await proFree()
    await expect(
      selector.resolve({ filter: { fact: { plan_tier: { eq: 'pro' } } } }, { projection: 'knowledge' })
    ).rejects.toThrow(/needs `about`/)
  })

  it('a passport scope with no about errors', async () => {
    const { a } = await proFree()
    await expect(
      selector.resolve({}, { projection: 'knowledge', scope: 'passport', passport: a })
    ).rejects.toThrow(/needs `about`/)
  })
})
