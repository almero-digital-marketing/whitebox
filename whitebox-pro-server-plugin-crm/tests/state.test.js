import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as state from '../src/state.js'

const logger = { debug: vi.fn(), error: vi.fn() }
let facts

beforeEach(() => {
  facts = { record: vi.fn(async () => ({})), current: vi.fn(async () => ({})) }
  state.init({ facts, logger })
})

const callsByKey = () => Object.fromEntries(facts.record.mock.calls.map(([a]) => [a.key, a]))

describe('crm state adapter (records → core facts)', () => {
  it('maps status → fact keyed by kind, and each scalar data field → its own fact', async () => {
    const res = await state.record({
      source: 'stripe', kind: 'subscription', external_id: 'sub_1', passport_id: 'p-1',
      status: 'active', starts_at: '2026-01-01T00:00:00Z', data: { plan_tier: 'pro', seats: 9 },
    })
    expect(res.written).toBe(3)
    const by = callsByKey()
    expect(by.subscription).toMatchObject({ passport_id: 'p-1', key: 'subscription', value: 'active', source: 'stripe', entity: 'subscription:sub_1' })
    expect(by.plan_tier).toMatchObject({ key: 'plan_tier', value: 'pro', entity: 'subscription:sub_1' })
    expect(by.seats).toMatchObject({ key: 'seats', value: 9 })
    // starts_at → observed_at on every fact
    for (const c of facts.record.mock.calls) expect(c[0].observed_at).toEqual(new Date('2026-01-01T00:00:00Z'))
  })

  it('skips non-scalar data fields (not value-queryable)', async () => {
    await state.record({
      source: 'hubspot', kind: 'deal', external_id: 'd1', passport_id: 'p-1',
      status: 'open', data: { amount: 500, owner: { id: 7, name: 'X' }, tags: ['a', 'b'] },
    })
    const keys = facts.record.mock.calls.map(([a]) => a.key).sort()
    expect(keys).toEqual(['amount', 'deal'])   // owner (object) + tags (array) skipped
  })

  it('records a bare presence fact when there is neither status nor scalar data', async () => {
    await state.record({ source: 'x', kind: 'reservation', external_id: 'r1', passport_id: 'p-1', status: null, data: {} })
    expect(facts.record).toHaveBeenCalledTimes(1)
    expect(facts.record.mock.calls[0][0]).toMatchObject({ key: 'reservation', value: true })
  })

  it('defaults observed_at to now when starts_at is absent', async () => {
    await state.record({ source: 'x', kind: 'k', external_id: '1', passport_id: 'p-1', status: 'a', data: {} })
    expect(facts.record.mock.calls[0][0].observed_at).toBeInstanceOf(Date)
  })

  it('counts only successful writes; a failed fact does not abort the rest', async () => {
    facts.record.mockImplementationOnce(async () => { throw new Error('down') })
    const res = await state.record({ source: 'x', kind: 'k', external_id: '1', passport_id: 'p-1', status: 'a', data: { f: 1 } })
    expect(res.written).toBe(1)   // 2 attempted (k + f), first threw
  })

  it('current() reads the passport\'s facts straight through', async () => {
    facts.current.mockResolvedValueOnce({ subscription: 'active', plan_tier: 'pro' })
    expect(await state.current('p-1')).toEqual({ subscription: 'active', plan_tier: 'pro' })
    expect(facts.current).toHaveBeenCalledWith('p-1')
  })
})
