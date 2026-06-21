import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import knex from 'knex'
import crypto from 'crypto'

import * as facts from '../../src/facts/index.js'
import * as selector from '../../src/selector/index.js'

const db = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 5 } })
const passports = { resolve: async id => id }
const logger = { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }
const ids = res => res.passports.map(p => p.id).sort()
const sorted = a => [...a].sort()
const d = s => new Date(s)

// awareness stub — about() resolves to a canned candidate set per query, and
// records the call so we can assert the similarity/limit passed through. (Real
// embeddings/vector search are exercised in awareness's own tests.)
let aboutMap = {}
let lastPopulationArgs = null
const awareness = {
  population: async (args) => {
    lastPopulationArgs = args
    return { passports: (aboutMap[args.query] || []).map(passport_id => ({ passport_id })) }
  },
}

beforeAll(async () => {
  facts.init({ db, passports, logger })
  await facts.migrate()
  selector.init({ db, passports, logger, awareness, config: {} })
})
afterAll(async () => { await db.destroy() })
beforeEach(async () => {
  aboutMap = {}; lastPopulationArgs = null
  await db.raw('TRUNCATE TABLE whitebox_facts, whitebox_passports CASCADE')
})

async function newPassport() { const id = crypto.randomUUID(); await db('whitebox_passports').insert({ id }); return id }
async function fixture() {
  const a = await newPassport(), b = await newPassport(), c = await newPassport()
  const at = d('2026-04-10')
  await facts.record({ passport_id: a, key: 'plan_tier', value: 'pro', observed_at: at })
  await facts.record({ passport_id: b, key: 'plan_tier', value: 'free', observed_at: at })
  await facts.record({ passport_id: c, key: 'plan_tier', value: 'pro', observed_at: at })
  return { a, b, c }
}

describe('selector about (semantic narrow → people gate)', () => {
  it('about-only gates to the semantic candidates', async () => {
    const { a, b } = await fixture()
    aboutMap['competitor, switching'] = [a, b]
    expect(ids(await selector.resolve({ about: 'competitor, switching' }, { projection: 'people' }))).toEqual(sorted([a, b]))
  })

  it('about + filter intersect — the filter gates the candidates', async () => {
    const { a, b } = await fixture()
    aboutMap['competitor, switching'] = [a, b]   // c is Pro but not a candidate
    const res = await selector.resolve(
      { about: 'competitor, switching', filter: { fact: { plan_tier: { eq: 'pro' } } } },
      { projection: 'people' })
    expect(ids(res)).toEqual([a])                // candidate ∩ Pro = a (b free, c not a candidate)
  })

  it('about intersects with caller scope', async () => {
    const { a, b } = await fixture()
    aboutMap['x'] = [a, b]
    expect(ids(await selector.resolve({ about: 'x' }, { projection: 'people', scope: [a] }))).toEqual([a])
  })

  it('passes the similarity floor + limit through; string form uses defaults', async () => {
    await fixture()
    aboutMap['x'] = []
    await selector.resolve({ about: { query: 'x', similarity: 0.85, limit: 50 } }, { projection: 'people' })
    expect(lastPopulationArgs).toMatchObject({ query: 'x', similarity: 0.85, limit: 50 })
    await selector.resolve({ about: 'x' }, { projection: 'people' })
    expect(lastPopulationArgs).toMatchObject({ query: 'x', similarity: 0.72, limit: 2000 })
  })
})
