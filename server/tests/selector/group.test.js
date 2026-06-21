import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import knex from 'knex'
import crypto from 'crypto'

import * as facts from '../../src/facts/index.js'
import * as selector from '../../src/selector/index.js'

const db = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 5 } })
const passports = { resolve: async id => id }
const logger = { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }
const d = s => new Date(s)
const asMap = series => Object.fromEntries(series.map(r => [r.bucket, r.value]))

beforeAll(async () => {
  facts.init({ db, passports, logger })
  await facts.migrate()
  selector.init({ db, passports, logger, awareness: {}, ai: {}, config: {} })
})
afterAll(async () => { await db.destroy() })
beforeEach(async () => { await db.raw('TRUNCATE TABLE whitebox_facts, whitebox_awareness_exposures, whitebox_passports CASCADE') })

async function newPassport() { const id = crypto.randomUUID(); await db('whitebox_passports').insert({ id }); return id }
async function expose(passport_id, { channel = 'web', ts, content = 'purchase', value, direction = 'expression' }) {
  await db('whitebox_awareness_exposures').insert({
    passport_id, ts: d(ts), channel, direction, text: 'x', content_id: content,
    meta: value == null ? null : JSON.stringify({ value }),
  })
}

// Two people, purchases across two days + channels, plus one non-purchase event.
async function fixture() {
  const p1 = await newPassport(), p2 = await newPassport()
  await expose(p1, { channel: 'web',   ts: '2026-05-01', value: 100 })
  await expose(p1, { channel: 'web',   ts: '2026-05-01', value: 50 })
  await expose(p2, { channel: 'email', ts: '2026-05-02', value: 200 })
  await expose(p2, { channel: 'web',   ts: '2026-05-02', content: 'pricing' })   // not a purchase
  return { p1, p2 }
}

const purchases = { filter: { metric: { content: 'purchase', count: {} } } }

describe('selector group (time-series + breakdown, §7)', () => {
  it('time-series: count of purchases by day', async () => {
    await fixture()
    const series = await selector.resolve(purchases, { group: { by: 'day' } })
    expect(asMap(series)).toEqual({ '2026-05-01': 2, '2026-05-02': 1 })
  })

  it('collapses same-week events; groups by month', async () => {
    await fixture()
    const byWeek = await selector.resolve(purchases, { group: { by: 'week' } })
    expect(byWeek).toHaveLength(1)                     // 05-01 (Fri) + 05-02 (Sat) are one ISO week
    expect(byWeek[0]).toMatchObject({ value: 3 })
    expect(byWeek[0].bucket).toMatch(/^2026-W\d{2}$/)  // ISO year-week label
    const byMonth = await selector.resolve(purchases, { group: { by: 'month' } })
    expect(asMap(byMonth)).toEqual({ '2026-05': 3 })
  })

  it('breakdown: count of purchases by channel', async () => {
    await fixture()
    const series = await selector.resolve(purchases, { group: { by: 'channel' } })
    expect(asMap(series)).toEqual({ web: 2, email: 1 })   // p2's web event was pricing, not purchase
  })

  it('sum aggregate bucketed by day', async () => {
    await fixture()
    const series = await selector.resolve(
      { filter: { metric: { content: 'purchase', sum: { field: 'value' } } } }, { group: { by: 'day' } })
    expect(asMap(series)).toEqual({ '2026-05-01': 150, '2026-05-02': 200 })
  })

  it('distinct_passports breakdown by channel', async () => {
    await fixture()
    const series = await selector.resolve(
      { filter: { metric: { content: 'purchase', distinct_passports: {} } } }, { group: { by: 'channel' } })
    expect(asMap(series)).toEqual({ web: 1, email: 1 })
  })

  it('restricts to a caller-provided scope (a cohort)', async () => {
    const { p1 } = await fixture()
    const series = await selector.resolve(purchases, { group: { by: 'day' }, scope: [p1] })
    expect(asMap(series)).toEqual({ '2026-05-01': 2 })   // only p1's events
  })

  it('honours asOf (ignores future events)', async () => {
    await fixture()
    const series = await selector.resolve(purchases, { group: { by: 'day' }, asOf: '2026-05-01T23:59:59Z' })
    expect(asMap(series)).toEqual({ '2026-05-01': 2 })   // 05-02 events excluded
  })

  it('errors when group has no metric to aggregate', async () => {
    await fixture()
    await expect(selector.resolve({ filter: { fact: { plan_tier: { eq: 'pro' } } } }, { group: { by: 'day' } }))
      .rejects.toThrow(/requires a single `metric`/)
  })

  it('errors on an unknown bucket', async () => {
    await fixture()
    await expect(selector.resolve(purchases, { group: { by: 'banana' } })).rejects.toThrow(/unknown bucket/)
  })
})
