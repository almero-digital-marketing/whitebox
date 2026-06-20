import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import knex from 'knex'
import crypto from 'crypto'

import * as facts from '../../src/facts/index.js'
import * as selector from '../../src/selector/index.js'

const db = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 1, max: 5 } })
const passports = { resolve: async id => id }
const logger = { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }

beforeAll(async () => {
  facts.init({ db, passports, logger })
  await facts.migrate()
  selector.init({ db, passports, logger, awareness: {}, ai: {}, config: {} })
})
afterAll(async () => { await db.destroy() })
beforeEach(async () => { await db.raw('TRUNCATE TABLE whitebox_facts, whitebox_passports CASCADE') })

async function newPassport() { const id = crypto.randomUUID(); await db('whitebox_passports').insert({ id }); return id }
async function event(pid, key, date) { await facts.record({ passport_id: pid, key, value: date, observed_at: new Date(date) }) }

// Steps modelled as event-facts: matched_at = the fact's observed_at.
const trial     = { filter: { fact: { trial_at:     { present: true } } } }
const activated = { filter: { fact: { activated_at: { present: true } } } }
const purchased = { filter: { fact: { purchased_at: { present: true } } } }

// The §14 worked-example base.
async function workedExample() {
  const p = {}
  for (const k of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) p[k] = await newPassport()
  await event(p.p1, 'trial_at', '2026-03-01'); await event(p.p1, 'activated_at', '2026-03-03'); await event(p.p1, 'purchased_at', '2026-03-10')
  await event(p.p2, 'trial_at', '2026-03-01'); await event(p.p2, 'activated_at', '2026-03-04'); await event(p.p2, 'purchased_at', '2026-04-20')
  await event(p.p3, 'trial_at', '2026-03-02'); await event(p.p3, 'activated_at', '2026-03-15')
  await event(p.p4, 'trial_at', '2026-03-02')
  await event(p.p5, 'trial_at', '2026-03-05'); await event(p.p5, 'activated_at', '2026-03-06'); await event(p.p5, 'purchased_at', '2026-03-08')
  return p
}

const spec = {
  steps: [
    { select: trial,     name: 'trial' },
    { select: activated, name: 'activated', within: '7d' },
    { select: purchased, name: 'purchased', within: '14d' },
  ],
}
const sorted = a => [...a].sort()

describe('selector funnel (§14 ordered windowed steps)', () => {
  it('reproduces the worked-example drop-off report', async () => {
    await workedExample()
    const f = await selector.funnel(spec, { asOf: '2026-05-01' })
    expect(f.report.map(r => r.count)).toEqual([5, 3, 2])
    expect(f.report[1].stepConversion).toBeCloseTo(0.6)   // 3/5
    expect(f.report[2].stepConversion).toBeCloseTo(2 / 3) // 2/3
    expect(f.report[2].overall).toBeCloseTo(0.4)          // 2/5
    expect(f.report.map(r => r.name)).toEqual(['trial', 'activated', 'purchased'])
  })

  it('the temporal join flags "did it, but not in time"', async () => {
    const p = await workedExample()
    const f = await selector.funnel(spec, { asOf: '2026-05-01' })
    // p2 purchased (Apr 20) and p3 activated (Mar 15) — both DID the event, both
    // dropped by the window. An unordered { all } would wrongly count them.
    expect(sorted(f.steps['step:2'])).toEqual(sorted([p.p1, p.p2, p.p5]))
    expect(sorted(f.steps['step:3'])).toEqual(sorted([p.p1, p.p5]))
  })

  it('gap cohorts: 1→2 = {p3,p4}, 2→3 = {p2}', async () => {
    const p = await workedExample()
    const f = await selector.funnel(spec, { asOf: '2026-05-01' })
    expect(sorted(f.gaps['gap:1→2'].ids)).toEqual(sorted([p.p3, p.p4]))
    expect(f.gaps['gap:2→3'].ids).toEqual([p.p2])
  })

  it('gap status: pending while the window is open, dropped once it closes', async () => {
    const a = await newPassport(), b = await newPassport()
    await event(a, 'trial_at', '2026-03-01')   // a: trial, no activation
    await event(b, 'trial_at', '2026-03-01')
    await event(b, 'activated_at', '2026-03-03')
    // clock Mar 5 → a's 7d window (closes Mar 8) is still OPEN → pending
    const open = await selector.funnel(spec, { asOf: '2026-03-05' })
    expect(open.gaps['gap:1→2'].pending).toEqual([a])
    expect(open.gaps['gap:1→2'].dropped).toEqual([])
    // clock Mar 20 → window closed → dropped
    const closed = await selector.funnel(spec, { asOf: '2026-03-20' })
    expect(closed.gaps['gap:1→2'].dropped).toEqual([a])
  })

  it('funnel.within drops a too-slow completer (total velocity gate)', async () => {
    const fast = await newPassport(), slow = await newPassport()
    for (const id of [fast, slow]) { await event(id, 'trial_at', '2026-03-01'); await event(id, 'activated_at', '2026-03-03') }
    await event(fast, 'purchased_at', '2026-03-05')   // total span 4d
    await event(slow, 'purchased_at', '2026-03-12')   // total span 11d — both pass the 14d step windows
    const within10 = await selector.funnel({ within: '10d', ...spec }, { asOf: '2026-05-01' })
    expect(within10.steps['step:3']).toEqual([fast])  // slow (11d) exceeds the 10d total
  })

  it('resolves named selectors by reference', async () => {
    const p = await workedExample()
    const named = { trial, activated, purchased }
    const f = await selector.funnel(
      { steps: [{ select: 'trial' }, { select: 'activated', within: '7d' }, { select: 'purchased', within: '14d' }] },
      { asOf: '2026-05-01', named })
    expect(f.report.map(r => r.count)).toEqual([5, 3, 2])
  })

  it('the slot accessor returns step + gap (and status) cohorts for audiences', async () => {
    const p = await workedExample()
    const f = await selector.funnel(spec, { asOf: '2026-05-01' })
    expect(sorted(selector.funnelSlot(f, 'step:3'))).toEqual(sorted([p.p1, p.p5]))
    expect(selector.funnelSlot(f, 'gap:2→3')).toEqual([p.p2])
    expect(selector.funnelSlot(f, 'gap:2→3', { status: 'dropped' })).toEqual([p.p2])
  })

  it('rejects an empty funnel', async () => {
    await expect(selector.funnel({ steps: [] }, {})).rejects.toThrow(/at least one step/)
  })
})
