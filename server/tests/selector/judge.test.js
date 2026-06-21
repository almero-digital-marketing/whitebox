import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import knex from 'knex'
import crypto from 'crypto'

import * as facts from '../../src/facts/index.js'
import * as selector from '../../src/selector/index.js'

const db = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 5 } })
const passports = { resolve: async id => id }
const logger = { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }
const ids = res => res.passports.map(p => p.id).sort()
const d = s => new Date(s)

// Stubs: about candidates per query; recall returns evidence whose text is the
// passport id; the LLM verdict per passport keyed off that id in the prompt.
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
  selector.init({ db, passports, logger, awareness, ai, config: {} })
})
afterAll(async () => { await db.destroy() })
beforeEach(async () => {
  aboutMap = {}; verdictMap = {}; aiCalls = 0
  await db.raw('TRUNCATE TABLE whitebox_facts, whitebox_passports CASCADE')
})

async function newPassport() { const id = crypto.randomUUID(); await db('whitebox_passports').insert({ id }); return id }
async function proFreePro() {
  const a = await newPassport(), b = await newPassport(), c = await newPassport()
  const at = d('2026-04-10')
  await facts.record({ passport_id: a, key: 'plan_tier', value: 'pro', observed_at: at })
  await facts.record({ passport_id: b, key: 'plan_tier', value: 'free', observed_at: at })
  await facts.record({ passport_id: c, key: 'plan_tier', value: 'pro', observed_at: at })
  return { a, b, c }
}

describe('selector judge (LLM predicate)', () => {
  it('keeps only confirmed candidates (match && score ≥ confidence) and attaches why/score', async () => {
    const { a, c } = await proFreePro()
    aboutMap['churn'] = [a, c]
    verdictMap[a] = { match: true, score: 0.9, reason: 'strong signal' }
    verdictMap[c] = { match: true, score: 0.5, reason: 'weak' }       // below 0.7
    const res = await selector.resolve(
      { about: 'churn', judge: { criteria: 'at churn risk', confidence: 0.7 } },
      { projection: 'people' })
    expect(ids(res)).toEqual([a])
    expect(res.passports[0]).toMatchObject({ id: a, why: 'strong signal', score: 0.9 })
  })

  it('runs the judge only on filter survivors (cost order)', async () => {
    const { a, b, c } = await proFreePro()
    aboutMap['churn'] = [a, b, c]                       // about lets all 3 in
    verdictMap[a] = { match: true, score: 0.9, reason: '' }
    verdictMap[c] = { match: true, score: 0.9, reason: '' }
    const res = await selector.resolve(
      { about: 'churn', filter: { fact: { plan_tier: { eq: 'pro' } } }, judge: { criteria: 'x', confidence: 0.7 } },
      { projection: 'people' })
    expect(ids(res)).toEqual([a, c].sort())
    expect(aiCalls).toBe(2)                             // b (free) was filtered out before the judge ran
  })

  it('drops a candidate the judge says does not match', async () => {
    const { a, c } = await proFreePro()
    aboutMap['x'] = [a, c]
    verdictMap[a] = { match: false, score: 0.95, reason: 'no' }       // high score but not a match
    verdictMap[c] = { match: true, score: 0.8, reason: 'yes' }
    const res = await selector.resolve({ about: 'x', judge: { criteria: 'x', confidence: 0.7 } }, { projection: 'people' })
    expect(ids(res)).toEqual([c])
  })
})
