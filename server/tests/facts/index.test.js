import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import knex from 'knex'
import crypto from 'crypto'

import * as facts from '../../src/facts/index.js'

// Real Postgres (a Neon branch provisioned by tests/setup/neon.js), same as
// passports.test.js — facts uses DISTINCT ON + jsonb, so we test against pg.
const db = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 5 } })

// passport-merge stub: resolve(absorbed) → survivor
let mergeMap = {}
const passports = { resolve: async id => mergeMap[id] ?? id }
const logger = { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }

const d = s => new Date(s)

beforeAll(async () => {
  facts.init({ db, passports, logger })
  await facts.migrate()                      // creates whitebox_facts in the branch
})

afterAll(async () => {
  await db.destroy()
})

beforeEach(async () => {
  mergeMap = {}
  await db.raw('TRUNCATE TABLE whitebox_facts, whitebox_passports CASCADE')
})

async function newPassport() {
  const id = crypto.randomUUID()
  await db('whitebox_passports').insert({ id })   // facts FK → whitebox_passports
  return id
}

describe('facts.record + current', () => {
  it('records a fact and reads it back as the current value', async () => {
    const p = await newPassport()
    await facts.record({ passport_id: p, key: 'plan_tier', value: 'pro', source: 'stripe', observed_at: d('2026-04-10') })
    expect(await facts.current(p)).toEqual({ plan_tier: 'pro' })
    expect(await facts.get(p, 'plan_tier')).toBe('pro')
  })

  it('a value change is a new row; current returns the latest per key', async () => {
    const p = await newPassport()
    await facts.record({ passport_id: p, key: 'plan_tier', value: 'free', source: 'stripe', observed_at: d('2026-03-01') })
    await facts.record({ passport_id: p, key: 'mrr', value: 0, source: 'stripe', observed_at: d('2026-03-01') })
    await facts.record({ passport_id: p, key: 'plan_tier', value: 'pro', source: 'stripe', observed_at: d('2026-04-10') })
    await facts.record({ passport_id: p, key: 'mrr', value: 240, source: 'stripe', observed_at: d('2026-04-10') })
    expect(await facts.current(p)).toEqual({ plan_tier: 'pro', mrr: 240 })
  })

  it('current can be filtered to specific keys', async () => {
    const p = await newPassport()
    await facts.record({ passport_id: p, key: 'plan_tier', value: 'pro', observed_at: d('2026-04-10') })
    await facts.record({ passport_id: p, key: 'mrr', value: 240, observed_at: d('2026-04-10') })
    expect(await facts.current(p, 'mrr')).toEqual({ mrr: 240 })
    expect(await facts.current(p, ['plan_tier'])).toEqual({ plan_tier: 'pro' })
  })
})

describe('facts.asOf (time travel)', () => {
  it('returns the value as it stood at a past instant', async () => {
    const p = await newPassport()
    await facts.record({ passport_id: p, key: 'plan_tier', value: 'free', observed_at: d('2026-03-01') })
    await facts.record({ passport_id: p, key: 'plan_tier', value: 'pro', observed_at: d('2026-04-10') })
    expect(await facts.asOf(p, '2026-03-15')).toEqual({ plan_tier: 'free' })
    expect(await facts.asOf(p, '2026-05-01')).toEqual({ plan_tier: 'pro' })
    expect(await facts.get(p, 'plan_tier', { at: '2026-03-15' })).toBe('free')
  })

  it('a key with no row before the instant is absent', async () => {
    const p = await newPassport()
    await facts.record({ passport_id: p, key: 'plan_tier', value: 'pro', observed_at: d('2026-04-10') })
    expect(await facts.asOf(p, '2026-04-01')).toEqual({})
  })
})

describe('facts type inference + round-trip', () => {
  it('infers number / bool / date / string and round-trips the value', async () => {
    const p = await newPassport()
    await facts.record({ passport_id: p, key: 'mrr', value: 240 })
    await facts.record({ passport_id: p, key: 'active', value: true })
    await facts.record({ passport_id: p, key: 'renewal_date', value: '2026-07-01' })
    await facts.record({ passport_id: p, key: 'plan_tier', value: 'pro' })
    expect(await facts.current(p)).toEqual({ mrr: 240, active: true, renewal_date: '2026-07-01', plan_tier: 'pro' })
    expect((await facts.history(p, 'mrr'))[0].type).toBe('number')
    expect((await facts.history(p, 'renewal_date'))[0].type).toBe('date')
  })
})

describe('facts.history', () => {
  it('returns the full timeline of a key, oldest first', async () => {
    const p = await newPassport()
    await facts.record({ passport_id: p, key: 'mrr', value: 0, observed_at: d('2026-03-01') })
    await facts.record({ passport_id: p, key: 'mrr', value: 240, observed_at: d('2026-04-10') })
    await facts.record({ passport_id: p, key: 'mrr', value: 560, observed_at: d('2026-05-20') })
    expect((await facts.history(p, 'mrr')).map(h => h.value)).toEqual([0, 240, 560])
  })
})

describe('passport merge resolution', () => {
  it('writes + reads under the survivor when the id was merged away', async () => {
    const survivor = await newPassport()
    const absorbed = crypto.randomUUID()          // merged away — no row of its own
    mergeMap[absorbed] = survivor
    await facts.record({ passport_id: absorbed, key: 'plan_tier', value: 'pro', observed_at: d('2026-04-10') })
    expect(await facts.current(survivor)).toEqual({ plan_tier: 'pro' })   // stored under survivor
    expect(await facts.current(absorbed)).toEqual({ plan_tier: 'pro' })   // read resolves too
  })
})

describe('facts.matches (population) + facts.test (per-passport)', () => {
  it('value op: who currently matches, per-passport test', async () => {
    const a = await newPassport(); const b = await newPassport(); const c = await newPassport()
    await facts.record({ passport_id: a, key: 'plan_tier', value: 'pro', observed_at: d('2026-04-10') })
    await facts.record({ passport_id: b, key: 'plan_tier', value: 'free', observed_at: d('2026-04-10') })
    await facts.record({ passport_id: c, key: 'plan_tier', value: 'pro', observed_at: d('2026-04-10') })
    expect(new Set(await facts.matches('plan_tier', { eq: 'pro' }))).toEqual(new Set([a, c]))
    expect(await facts.test(a, 'plan_tier', { eq: 'pro' })).toBe(true)
    expect(await facts.test(b, 'plan_tier', { eq: 'pro' })).toBe(false)
  })

  it('value op honors scope and as-of', async () => {
    const a = await newPassport(); const b = await newPassport()
    await facts.record({ passport_id: a, key: 'plan_tier', value: 'free', observed_at: d('2026-03-01') })
    await facts.record({ passport_id: a, key: 'plan_tier', value: 'pro', observed_at: d('2026-04-10') })
    await facts.record({ passport_id: b, key: 'plan_tier', value: 'pro', observed_at: d('2026-02-01') })
    expect(new Set(await facts.matches('plan_tier', { eq: 'pro' }))).toEqual(new Set([a, b]))   // now: both
    expect(await facts.matches('plan_tier', { eq: 'pro' }, { scope: [a] })).toEqual([a])
    expect(await facts.matches('plan_tier', { eq: 'pro' }, { at: '2026-03-15' })).toEqual([b])  // a was 'free' then
  })

  it('temporal op: transition into a state within a window', async () => {
    const a = await newPassport(); const b = await newPassport()
    await facts.record({ passport_id: a, key: 'subscription_status', value: 'active', observed_at: d('2026-04-10') })
    await facts.record({ passport_id: a, key: 'subscription_status', value: 'cancelled', observed_at: d('2026-06-15') })
    await facts.record({ passport_id: b, key: 'subscription_status', value: 'active', observed_at: d('2026-04-10') })
    const pred = { transition: { to: 'cancelled', last: '90d' } }
    expect(await facts.matches('subscription_status', pred, { at: '2026-06-20' })).toEqual([a])
    expect(await facts.test(a, 'subscription_status', pred, { at: '2026-06-20' })).toBe(true)
    expect(await facts.test(b, 'subscription_status', pred, { at: '2026-06-20' })).toBe(false)
  })
})

describe('validation', () => {
  it('throws on missing passport_id / key / value', async () => {
    await expect(facts.record({ key: 'k', value: 1 })).rejects.toThrow(/passport_id/)
    await expect(facts.record({ passport_id: 'p', value: 1 })).rejects.toThrow(/key/)
    await expect(facts.record({ passport_id: 'p', key: 'k' })).rejects.toThrow(/value/)
  })
})
