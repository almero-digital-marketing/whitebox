import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import knex from 'knex'
import crypto from 'crypto'

import * as facts from '../../src/facts/index.js'
import * as selector from '../../src/selector/index.js'

const db = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 5 } })
const passports = { resolve: async id => id }
const logger = { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }
const d = s => new Date(s)
const ids = res => res.passports.map(p => p.id).sort()
const sorted = arr => [...arr].sort()

beforeAll(async () => {
  facts.init({ db, passports, logger })
  await facts.migrate()
  selector.init({ db, passports, logger })
})

afterAll(async () => { await db.destroy() })

beforeEach(async () => {
  await db.raw('TRUNCATE TABLE whitebox_facts, whitebox_passports CASCADE')
})

async function newPassport() {
  const id = crypto.randomUUID()
  await db('whitebox_passports').insert({ id })
  return id
}

// Shared fixture: three passports with structured facts.
async function fixture() {
  const a = await newPassport(), b = await newPassport(), c = await newPassport()
  const at = d('2026-04-10')
  await facts.record({ passport_id: a, key: 'plan_tier', value: 'pro', observed_at: at })
  await facts.record({ passport_id: a, key: 'seat_count', value: 7, observed_at: at })
  await facts.record({ passport_id: a, key: 'subscription_status', value: 'active', observed_at: at })
  await facts.record({ passport_id: b, key: 'plan_tier', value: 'free', observed_at: at })
  await facts.record({ passport_id: b, key: 'seat_count', value: 2, observed_at: at })
  await facts.record({ passport_id: c, key: 'plan_tier', value: 'pro', observed_at: at })
  await facts.record({ passport_id: c, key: 'seat_count', value: 3, observed_at: at })
  await facts.record({ passport_id: c, key: 'subscription_status', value: 'cancelled', observed_at: at })
  return { a, b, c }
}

describe('selector.resolve — filter (people)', () => {
  it('a single fact clause', async () => {
    const { a, c } = await fixture()
    const res = await selector.resolve({ filter: { fact: { plan_tier: { eq: 'pro' } } } }, { projection: 'people' })
    expect(res.count).toBe(2)
    expect(ids(res)).toEqual(sorted([a, c]))
  })

  it('all = intersection', async () => {
    const { a } = await fixture()
    const res = await selector.resolve(
      { filter: { all: [ { fact: { plan_tier: { eq: 'pro' } } }, { fact: { seat_count: { gte: 5 } } } ] } },
      { projection: 'people' })
    expect(ids(res)).toEqual([a])     // pro AND ≥5 seats → a only (c has 3)
  })

  it('all + not = set difference (no full scan needed)', async () => {
    const { a } = await fixture()
    const res = await selector.resolve(
      { filter: { all: [
        { fact: { plan_tier: { eq: 'pro' } } },
        { not: { fact: { subscription_status: { eq: 'cancelled' } } } },
      ] } },
      { projection: 'people' })
    expect(ids(res)).toEqual([a])     // pro AND not cancelled → a (c is cancelled, b not pro)
  })

  it('any = union', async () => {
    const { a, b } = await fixture()
    const res = await selector.resolve(
      { filter: { any: [ { fact: { plan_tier: { eq: 'free' } } }, { fact: { seat_count: { gte: 7 } } } ] } },
      { projection: 'people' })
    expect(ids(res)).toEqual(sorted([a, b]))   // free (b) OR ≥7 seats (a)
  })

  it('top-level not (full-population scan)', async () => {
    const { b } = await fixture()
    const res = await selector.resolve({ filter: { not: { fact: { plan_tier: { eq: 'pro' } } } } }, { projection: 'people' })
    expect(ids(res)).toEqual([b])     // everyone except pro (a, c) → b
  })

  it('honors scope', async () => {
    const { a, b } = await fixture()
    const res = await selector.resolve({ filter: { fact: { plan_tier: { eq: 'pro' } } } }, { projection: 'people', scope: [a, b] })
    expect(ids(res)).toEqual([a])     // c excluded by scope
  })

  it('honors asOf (time travel)', async () => {
    const a = await newPassport()
    await facts.record({ passport_id: a, key: 'plan_tier', value: 'free', observed_at: d('2026-03-01') })
    await facts.record({ passport_id: a, key: 'plan_tier', value: 'pro', observed_at: d('2026-04-10') })
    expect(ids(await selector.resolve({ filter: { fact: { plan_tier: { eq: 'pro' } } } }, { projection: 'people' }))).toEqual([a])
    expect(ids(await selector.resolve({ filter: { fact: { plan_tier: { eq: 'pro' } } } }, { projection: 'people', asOf: '2026-03-15' }))).toEqual([])
  })

  it('empty filter = everyone', async () => {
    const { a, b, c } = await fixture()
    const res = await selector.resolve({}, { projection: 'people' })
    expect(ids(res)).toEqual(sorted([a, b, c]))
  })
})
