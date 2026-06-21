import { describe, it, expect } from 'vitest'
import { validate, toRow, fromRow } from '../src/rules.js'

const base = { id: 'churn_risk', name: 'Churn risk', select: { about: 'cancel, competitor', judge: { criteria: 'at risk', confidence: 0.7 } } }

describe('audience rule schema (selector-based)', () => {
  it('validates a select-based rule and applies defaults', () => {
    const r = validate(base)
    expect(r.select.about).toBe('cancel, competitor')
    expect(r).toMatchObject({ enabled: false, ttl_days: 30, policy: 'non_sensitive', delivery: {} })
  })

  it('accepts a purely structural selector (filter only, no about/judge)', () => {
    const r = validate({ id: 'pro', name: 'Pro', select: { filter: { fact: { plan_tier: { eq: 'pro' } } } } })
    expect(r.select.filter).toBeTruthy()
  })

  it('rejects an empty selector (would mean "everyone")', () => {
    expect(() => validate({ id: 'x', name: 'X', select: {} })).toThrow(/at least one of about/)
  })

  it('rejects the retired legacy fields (strict schema)', () => {
    expect(() => validate({ ...base, seed: 'x', criteria: 'y' })).toThrow(/invalid rule/)
  })

  it('round-trips a select rule through toRow / fromRow', () => {
    const rule = validate(base)
    const row = toRow(rule, 'tester')
    expect(typeof row.selector).toBe('string')          // jsonb serialized
    expect(row.funnel).toBeNull()
    const back = fromRow({ ...row })
    expect(back.select).toEqual(rule.select)
    expect(back).not.toHaveProperty('funnel')
    expect(back.updated_by).toBe('tester')
  })
})

const funnelBase = {
  id: 'winback', name: 'Win-back',
  funnel: { steps: [{ select: { filter: { fact: { trial_at: { present: true } } } } }, { select: { filter: { fact: { activated_at: { present: true } } } }, within: '7d' }] },
  slot: 'gap:1→2', status: 'dropped',
}

describe('audience rule schema — funnel source (§14)', () => {
  it('validates a funnel + slot source', () => {
    const r = validate(funnelBase)
    expect(r.funnel.steps).toHaveLength(2)
    expect(r.slot).toBe('gap:1→2')
    expect(r.status).toBe('dropped')
  })

  it('rejects a rule with BOTH select and funnel (exactly one source)', () => {
    expect(() => validate({ ...funnelBase, select: { about: 'x' } })).toThrow(/exactly one source/)
  })

  it('rejects a rule with NEITHER source', () => {
    expect(() => validate({ id: 'x', name: 'X' })).toThrow(/exactly one source/)
  })

  it('a funnel source requires a slot', () => {
    const { slot, status, ...noSlot } = funnelBase
    expect(() => validate(noSlot)).toThrow(/needs a `slot`/)
  })

  it('status only applies to a gap slot, not a step slot', () => {
    expect(() => validate({ ...funnelBase, slot: 'step:2', status: 'pending' })).toThrow(/only applies to a gap/)
    expect(validate({ ...funnelBase, slot: 'step:2', status: undefined }).slot).toBe('step:2')
  })

  it('rejects a malformed slot', () => {
    expect(() => validate({ ...funnelBase, slot: 'banana' })).toThrow(/slot must be/)
  })

  it('round-trips a funnel rule through toRow / fromRow', () => {
    const rule = validate(funnelBase)
    const row = toRow(rule, 'tester')
    expect(row.selector).toBeNull()
    expect(typeof row.funnel).toBe('string')
    expect(row.slot).toBe('gap:1→2')
    const back = fromRow({ ...row })
    expect(back).not.toHaveProperty('select')
    expect(back.funnel).toEqual(rule.funnel)
    expect(back.slot).toBe('gap:1→2')
    expect(back.status).toBe('dropped')
  })
})
