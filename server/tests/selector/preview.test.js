import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import knex from 'knex'
import crypto from 'crypto'

import * as facts from '../../src/facts/index.js'
import * as selector from '../../src/selector/index.js'

const db = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 5 } })
const passports = { resolve: async id => id }
const logger = { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }
const d = s => new Date(s)

// Stubs mirror judge.test.js: about candidates per query, recall returns the
// passport id as evidence text, and the LLM verdict is keyed off that id.
let aboutMap = {}
let verdictMap = {}
let aiCalls = 0
const awareness = {
  population: async ({ query }) => ({ passports: (aboutMap[query] || []).map(passport_id => ({ passport_id })) }),
  recall: async ({ passport_id }) => [{ channel: 'web', direction: 'expression', text: passport_id }],
}
const ai = {
  object: async (_system, user) => {
    aiCalls++
    for (const [id, v] of Object.entries(verdictMap)) if (user.includes(id)) return v
    return { match: false, score: 0, reason: '' }
  },
}

beforeAll(async () => {
  facts.init({ db, passports, logger })
  await facts.migrate()
  // small sample + low confirm-cap so the test can exercise both knobs cheaply
  selector.init({ db, passports, logger, awareness, ai, config: { selector: { previewSample: 2, confirmCap: 3 } } })
})
afterAll(async () => { await db.destroy() })
beforeEach(async () => {
  aboutMap = {}; verdictMap = {}; aiCalls = 0
  await db.raw('TRUNCATE TABLE whitebox_facts, whitebox_passports CASCADE')
})

async function newPassport() { const id = crypto.randomUUID(); await db('whitebox_passports').insert({ id }); return id }
async function pros(n) {
  const out = []
  const at = d('2026-04-10')
  for (let k = 0; k < n; k++) {
    const id = await newPassport()
    await facts.record({ passport_id: id, key: 'plan_tier', value: 'pro', observed_at: at })
    out.push(id)
  }
  return out
}

describe('selector preview (cost metadata, S4)', () => {
  it('reports about cohort + filter survivors with no LLM when there is no judge', async () => {
    const [a, b, c] = await pros(3)
    aboutMap['churn'] = [a, b, c]
    const p = await selector.preview(
      { about: 'churn', filter: { fact: { plan_tier: { eq: 'pro' } } } },
      { projection: 'people' })
    expect(p.about).toEqual({ cohort: 3 })
    expect(p.filter).toEqual({ survivors: 3 })
    expect(p.judge).toBeNull()      // no selector.judge ⇒ survivors are the audience
    expect(aiCalls).toBe(0)         // preview is cheap when there's nothing to judge
  })

  it('samples the judge (≤ previewSample) and projects the qualifying rate', async () => {
    const all = await pros(4)
    aboutMap['x'] = all
    // every candidate "matches" → sample qualifies 100% → projected = all survivors
    for (const id of all) verdictMap[id] = { match: true, score: 0.9, reason: `why ${id}` }
    const p = await selector.preview(
      { about: 'x', judge: { criteria: 'x', confidence: 0.7 } },
      { projection: 'people' })
    expect(p.filter.survivors).toBe(4)
    expect(p.judge.calls).toBe(4)              // a full run would judge all 4
    expect(p.judge.sample).toBe(2)             // but preview only sampled previewSample=2
    expect(aiCalls).toBe(2)                    // …and only made 2 LLM calls
    expect(p.judge.qualifyingRate).toBe(1)
    expect(p.judge.projectedMatches).toBe(4)   // rate × survivors
    expect(p.judge.reasons.length).toBeGreaterThan(0)
    expect(p.judge.estLatencyMs).toBeGreaterThan(0)
  })

  it('half-qualifying sample halves the projection', async () => {
    const all = await pros(4)
    aboutMap['x'] = all
    // first two candidates (the sampled slice) split 1 match / 1 no-match → 50%
    verdictMap[all[0]] = { match: true, score: 0.9, reason: 'yes' }
    verdictMap[all[1]] = { match: false, score: 0.9, reason: 'no' }
    const p = await selector.preview(
      { about: 'x', judge: { criteria: 'x', confidence: 0.7 } },
      { projection: 'people' })
    expect(p.judge.sample).toBe(2)
    expect(p.judge.qualifyingRate).toBe(0.5)
    expect(p.judge.projectedMatches).toBe(2)   // 0.5 × 4
  })

  it('flags a full-population scan when the filter has no positive anchor', async () => {
    await pros(2)
    const p = await selector.preview({}, { projection: 'people' })   // empty selector ⇒ everyone
    expect(p.fullScan).toBe(true)
    expect(p.about).toBeNull()
    expect(p.filter.survivors).toBe(2)
  })

  it('does not flag a full scan when about anchors the cohort', async () => {
    const [a, b] = await pros(2)
    aboutMap['x'] = [a, b]
    const p = await selector.preview({ about: 'x' }, { projection: 'people' })
    expect(p.fullScan).toBe(false)
    expect(p.about).toEqual({ cohort: 2 })
  })

  it('requires confirmation above the survivor cap', async () => {
    const all = await pros(4)               // confirmCap is 3 in this suite
    aboutMap['x'] = all
    const p = await selector.preview({ about: 'x' }, { projection: 'people' })
    expect(p.confirmCap).toBe(3)
    expect(p.filter.survivors).toBe(4)
    expect(p.confirmRequired).toBe(true)
  })
})
