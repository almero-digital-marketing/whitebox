import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import knex from 'knex'
import crypto from 'crypto'

import * as facts from '../../src/facts/index.js'
import * as selector from '../../src/selector/index.js'

// Exercises the additive metric dimensions (docs/event-attributes.md): session-
// joined UTM columns and meta attributes, in BOTH the people gate and the group
// chart, plus the high-cardinality limit guardrail.
const db = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 5 } })
const passports = { resolve: async id => id }
const logger = { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }
const d = s => new Date(s)
const ids = res => res.passports.map(p => p.id).sort()
const sorted = a => [...a].sort()
const asMap = series => Object.fromEntries(series.map(r => [r.bucket ?? '∅', r.value]))

beforeAll(async () => {
  facts.init({ db, passports, logger })
  await facts.migrate()
  selector.init({ db, passports, logger, awareness: {}, ai: {}, config: {} })
})
afterAll(async () => { await db.destroy() })
beforeEach(async () => {
  await db.raw('TRUNCATE TABLE whitebox_facts, whitebox_awareness_exposures, whitebox_sessions, whitebox_passports CASCADE')
})

async function newPassport() { const id = crypto.randomUUID(); await db('whitebox_passports').insert({ id }); return id }
async function newSession(passport_id, utms) {
  const [{ id }] = await db('whitebox_sessions').insert({ passport_id, ...utms }).returning('id')
  return id
}
async function expose(passport_id, { channel = 'mail', ts = '2026-05-01', session_id = null, meta = null, direction = 'exposure' } = {}) {
  await db('whitebox_awareness_exposures').insert({
    passport_id, ts: d(ts), channel, direction, text: 'x',
    session_id, meta: meta == null ? null : JSON.stringify(meta),
  })
}

// p1: 2 events in a spring_botox/google session (email_open w/ campaign, email_click)
// p2: 1 event in a winter_filler/meta session (email_open)
// p3: 1 event with NO session (page_view)
async function fixture() {
  const p1 = await newPassport(), p2 = await newPassport(), p3 = await newPassport()
  const sA = await newSession(p1, { utm_campaign: 'spring_botox', utm_source: 'google' })
  const sB = await newSession(p2, { utm_campaign: 'winter_filler', utm_source: 'meta' })
  await expose(p1, { session_id: sA, meta: { event: 'email_open', campaign: 'spring_botox' } })
  await expose(p1, { session_id: sA, meta: { event: 'email_click' } })
  await expose(p2, { session_id: sB, meta: { event: 'email_open' } })
  await expose(p3, { channel: 'web', session_id: null, meta: { event: 'page_view' } })
  return { p1, p2, p3 }
}

describe('selector metric — session-joined dimensions', () => {
  it('gate: filters people by a session UTM column (via the join)', async () => {
    const { p1 } = await fixture()
    const res = await selector.resolve(
      { filter: { metric: { session: { utm_campaign: 'spring_botox' }, count: { gte: 1 } } } },
      { projection: 'people' })
    expect(ids(res)).toEqual([p1])               // p2 is winter_filler, p3 has no session
  })

  it('group: breaks down by session:utm_campaign, with a null bucket for session-less events', async () => {
    await fixture()
    const series = await selector.resolve(
      { filter: { metric: { count: {} } } }, { group: { by: 'session:utm_campaign' } })
    expect(asMap(series)).toEqual({ spring_botox: 2, winter_filler: 1, '∅': 1 })   // ∅ = p3 (no session)
  })

  it('rejects an unknown session column (allowlist)', async () => {
    await fixture()
    await expect(selector.resolve(
      { filter: { metric: { session: { drop_table: 'x' }, count: { gte: 1 } } } }, { projection: 'people' }))
      .rejects.toThrow(/unknown session column/)
  })
})

describe('selector metric — meta attributes', () => {
  it('gate: equality on a meta attr', async () => {
    const { p1, p2 } = await fixture()
    const res = await selector.resolve(
      { filter: { metric: { attrs: { event: 'email_open' }, count: { gte: 1 } } } }, { projection: 'people' })
    expect(ids(res)).toEqual(sorted([p1, p2]))   // p3 is page_view
  })

  it('gate: `in` on a meta attr', async () => {
    const { p1, p2 } = await fixture()
    const res = await selector.resolve(
      { filter: { metric: { attrs: { event: { in: ['email_open', 'email_click'] } }, count: { gte: 1 } } } },
      { projection: 'people' })
    expect(ids(res)).toEqual(sorted([p1, p2]))
  })

  it('gate: `present` on a meta attr (key exists)', async () => {
    const { p1 } = await fixture()
    const res = await selector.resolve(
      { filter: { metric: { attrs: { campaign: { present: true } }, count: { gte: 1 } } } }, { projection: 'people' })
    expect(ids(res)).toEqual([p1])               // only p1's first event carries `campaign`
  })

  it('group: breaks down by attr:event', async () => {
    await fixture()
    const series = await selector.resolve(
      { filter: { metric: { count: {} } } }, { group: { by: 'attr:event' } })
    expect(asMap(series)).toEqual({ email_open: 2, email_click: 1, page_view: 1 })
  })

  it('combines an attr filter with an attr group', async () => {
    await fixture()
    const series = await selector.resolve(
      { filter: { metric: { attrs: { event: 'email_open' }, count: {} } } }, { group: { by: 'attr:campaign' } })
    // only email_opens counted: p1 (campaign=spring_botox) + p2 (no campaign → null)
    expect(asMap(series)).toEqual({ spring_botox: 1, '∅': 1 })
  })
})

describe('selector group — high-cardinality guardrail', () => {
  it('limit returns the top-N buckets by value', async () => {
    await fixture()
    const series = await selector.resolve(
      { filter: { metric: { count: {} } } }, { group: { by: 'attr:event', limit: 1 } })
    expect(series).toHaveLength(1)
    expect(series[0]).toEqual({ bucket: 'email_open', value: 2 })   // the most frequent action
  })
})

describe('selector metric — backward compatibility', () => {
  it('channel column filter + group still work unchanged', async () => {
    await fixture()
    const series = await selector.resolve({ filter: { metric: { count: {} } } }, { group: { by: 'channel' } })
    expect(asMap(series)).toEqual({ mail: 3, web: 1 })
  })

  it('deprecated content substring filter still resolves', async () => {
    const p = await newPassport()
    await db('whitebox_awareness_exposures').insert({ passport_id: p, ts: d('2026-05-01'), channel: 'web', direction: 'exposure', text: 'x', content_id: 'legacy:purchase:item' })
    const res = await selector.resolve({ filter: { metric: { content: 'purchase', count: { gte: 1 } } } }, { projection: 'people' })
    expect(ids(res)).toEqual([p])
  })
})
