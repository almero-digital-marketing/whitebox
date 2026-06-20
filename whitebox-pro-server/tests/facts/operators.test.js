import { describe, it, expect } from 'vitest'
import { matchValue, matchTemporal, isTemporal } from '../../src/facts/operators.js'

// Fixed "now" so the date-relative ops are deterministic.
const NOW = new Date('2026-06-20T00:00:00Z')
const mv = (value, predicate) => matchValue(value, predicate, NOW)
const mt = (history, predicate) => matchTemporal(history, predicate, NOW)
const row = (value, observed_at) => ({ value, observed_at })

describe('matchValue — value operators', () => {
  it('eq / ne / in', () => {
    expect(mv('pro', { eq: 'pro' })).toBe(true)
    expect(mv('pro', { eq: 'free' })).toBe(false)
    expect(mv('pro', { ne: 'free' })).toBe(true)
    expect(mv('pro', { in: ['pro', 'enterprise'] })).toBe(true)
    expect(mv('free', { in: ['pro', 'enterprise'] })).toBe(false)
  })

  it('numeric gt / gte / lt / lte and ranges', () => {
    expect(mv(240, { gte: 200 })).toBe(true)
    expect(mv(240, { gt: 240 })).toBe(false)
    expect(mv(240, { lt: 300 })).toBe(true)
    expect(mv(240, { gte: 200, lte: 300 })).toBe(true)   // AND-ed range
    expect(mv(500, { gte: 200, lte: 300 })).toBe(false)
  })

  it('present / absent', () => {
    expect(mv('x', { present: true })).toBe(true)
    expect(mv(undefined, { present: false })).toBe(true)
    expect(mv(undefined, { present: true })).toBe(false)
    expect(mv(undefined, { eq: 'x' })).toBe(false)       // any op on an absent key fails
  })

  it('date ops: next (upcoming) / last (recent) / before (older)', () => {
    expect(mv('2026-07-01', { next: '30d' })).toBe(true)    // 11 days ahead
    expect(mv('2026-07-01', { next: '7d' })).toBe(false)
    expect(mv('2026-06-10', { last: '30d' })).toBe(true)     // 10 days ago
    expect(mv('2026-06-10', { last: '5d' })).toBe(false)
    expect(mv('2026-03-01', { before: '60d' })).toBe(true)    // ~110 days ago
    expect(mv('2026-03-01', { before: '200d' })).toBe(false)
  })
})

describe('matchTemporal — change / transition operators', () => {
  const status = [row('active', '2026-04-10'), row('cancelled', '2026-06-15')]
  const mrr = [row(0, '2026-03-01'), row(240, '2026-04-10'), row(560, '2026-05-20')]

  it('transition into a state, windowed', () => {
    expect(mt(status, { transition: { to: 'cancelled', last: '90d' } })).toBe(true)
    expect(mt(status, { transition: { to: 'cancelled', last: '3d' } })).toBe(false)   // change was Jun 15
    expect(mt(status, { transition: { from: 'active', to: 'cancelled', last: '90d' } })).toBe(true)
    expect(mt(status, { transition: { to: 'active', last: '90d' } })).toBe(false)      // only the initial set
  })

  it('changed', () => {
    expect(mt(status, { changed: { last: '30d' } })).toBe(true)
    expect(mt(status, { changed: { last: '3d' } })).toBe(false)
  })

  it('increased / decreased', () => {
    expect(mt(mrr, { increased: { last: '60d' } })).toBe(true)       // 240 → 560 on May 20
    expect(mt(mrr, { decreased: { last: '60d' } })).toBe(false)
    const drop = [row(560, '2026-05-20'), row(300, '2026-06-18')]
    expect(mt(drop, { decreased: { last: '30d' } })).toBe(true)
  })
})

describe('isTemporal', () => {
  it('flags temporal predicates', () => {
    expect(isTemporal({ eq: 'pro' })).toBe(false)
    expect(isTemporal({ transition: { to: 'x', last: '30d' } })).toBe(true)
    expect(isTemporal({ changed: { last: '7d' } })).toBe(true)
  })
})
