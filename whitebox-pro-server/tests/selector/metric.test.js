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

const now = new Date()
const daysAgo = n => new Date(now.getTime() - n * 86400000)

beforeAll(async () => {
  facts.init({ db, passports, logger })
  await facts.migrate()
  selector.init({ db, passports, logger })
})

afterAll(async () => { await db.destroy() })

beforeEach(async () => {
  await db.raw('TRUNCATE TABLE whitebox_facts, whitebox_passports CASCADE')   // cascades to exposures + sessions
})

async function newPassport() {
  const id = crypto.randomUUID()
  await db('whitebox_passports').insert({ id })
  return id
}
// Insert an awareness exposure directly (bypassing awareness.record so the test
// needs no ai/queue) — metric clauses aggregate this table.
async function exposure(passport_id, { ts, channel = 'web', direction = 'exposure', content_id = null, session_id = null, dwell_ms = null, meta = null }) {
  await db('whitebox_awareness_exposures').insert({
    passport_id, ts, channel, direction, content_id, session_id, dwell_ms,
    meta: meta ? JSON.stringify(meta) : null, text: 'x',
  })
}
const resolvePeople = filter => selector.resolve({ filter }, { projection: 'people' })

describe('selector metric clauses', () => {
  it('count over content', async () => {
    const a = await newPassport(), b = await newPassport()
    await exposure(a, { ts: daysAgo(2), content_id: 'pricing-page' })
    await exposure(a, { ts: daysAgo(1), content_id: 'pricing-faq' })
    await exposure(b, { ts: daysAgo(1), content_id: 'pricing-page' })
    expect(ids(await resolvePeople({ metric: { content: 'pricing', count: { gte: 2 } } }))).toEqual([a])
  })

  it('sum of a meta field', async () => {
    const a = await newPassport(), b = await newPassport()
    await exposure(a, { ts: daysAgo(3), direction: 'conversion', content_id: 'purchase', meta: { value: 400 } })
    await exposure(a, { ts: daysAgo(1), direction: 'conversion', content_id: 'purchase', meta: { value: 250 } })
    await exposure(b, { ts: daysAgo(1), direction: 'conversion', content_id: 'purchase', meta: { value: 100 } })
    expect(ids(await resolvePeople({ metric: { content: 'purchase', sum: { field: 'value', gte: 500 } } }))).toEqual([a]) // a=650
  })

  it('recency_days — active within / gone quiet', async () => {
    const a = await newPassport(), b = await newPassport()
    await exposure(a, { ts: daysAgo(3), content_id: 'x' })
    await exposure(b, { ts: daysAgo(90), content_id: 'x' })
    expect(ids(await resolvePeople({ metric: { recency_days: { lte: 30 } } }))).toEqual([a])   // active within 30d
    expect(ids(await resolvePeople({ metric: { recency_days: { gte: 60 } } }))).toEqual([b])   // quiet ≥ 60d
  })

  it('within window', async () => {
    const a = await newPassport()
    await exposure(a, { ts: daysAgo(40), content_id: 'pricing' })   // old
    await exposure(a, { ts: daysAgo(2), content_id: 'pricing' })    // recent
    expect(ids(await resolvePeople({ metric: { content: 'pricing', within: '7d', count: { gte: 1 } } }))).toEqual([a])
    expect((await resolvePeople({ metric: { content: 'pricing', within: '7d', count: { gte: 2 } } })).count).toBe(0)
  })

  it('distinct_sessions', async () => {
    const a = await newPassport()
    const [{ id: s1 }] = await db('whitebox_sessions').insert({ passport_id: a }).returning('id')
    const [{ id: s2 }] = await db('whitebox_sessions').insert({ passport_id: a }).returning('id')
    await exposure(a, { ts: daysAgo(2), content_id: 'pricing', session_id: s1 })
    await exposure(a, { ts: daysAgo(1), content_id: 'pricing', session_id: s2 })
    expect(ids(await resolvePeople({ metric: { content: 'pricing', distinct_sessions: { gte: 2 } } }))).toEqual([a])
  })

  it('composes with a fact clause in the boolean tree', async () => {
    const a = await newPassport(), b = await newPassport()
    await facts.record({ passport_id: a, key: 'plan_tier', value: 'pro', observed_at: daysAgo(10) })
    await facts.record({ passport_id: b, key: 'plan_tier', value: 'pro', observed_at: daysAgo(10) })
    await exposure(a, { ts: daysAgo(2), content_id: 'pricing' })
    await exposure(a, { ts: daysAgo(1), content_id: 'pricing' })
    const res = await resolvePeople({ all: [
      { fact: { plan_tier: { eq: 'pro' } } },
      { metric: { content: 'pricing', count: { gte: 2 } } },
    ] })
    expect(ids(res)).toEqual([a])   // Pro AND ≥2 pricing visits — b is Pro but no pricing
  })
})
