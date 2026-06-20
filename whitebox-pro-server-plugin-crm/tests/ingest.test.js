import { describe, it, expect, vi, beforeEach } from 'vitest'

// ingest imports the real state module directly (`import * as state`). Mock it so
// each test can swap in a fresh stub whose record() the assertions inspect. The
// mock's exported functions delegate to whatever stub setState() installed.
let currentState
vi.mock('../src/state.js', () => ({
  init: vi.fn(),
  record: vi.fn((...args) => currentState.record(...args)),
  current: vi.fn((...args) => currentState.current(...args)),
}))

import * as ingest from '../src/ingest.js'
import * as state from '../src/state.js'

function makeState() {
  const store = []
  return {
    _store: store,
    record: vi.fn(async (r) => { store.push(r); return { ...r, written: 1 } }),
    current: vi.fn(async () => ({})),
  }
}

function setup({ passports, awareness } = {}) {
  passports ??= makePassports()
  awareness ??= makeAwareness()
  ingest.init({ passports, awareness, logger })
  return ingest
}

function setState(stub) {
  currentState = stub
  return stub
}

function makePassports({ byIdentity = {}, newPassportId = 'p-new' } = {}) {
  return {
    findByIdentity: vi.fn(async (type, value) => byIdentity[`${type}|${value}`] ?? null),
    identify: vi.fn(async () => newPassportId),
    link: vi.fn(async () => {}),
  }
}

function makeAwareness() {
  return { record: vi.fn(async () => ({ id: 1 })) }
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

beforeEach(() => {
  vi.clearAllMocks()
  setState(makeState())
})

describe('crm.ingest — shared identity gate', () => {
  it('drops records when customer has no identity at all', async () => {
    const passports = makePassports()
    const ingest = setup({ passports })

    const result = await ingest.ingestRecords({
      source: 'booking',
      customer: {},
      records: [{ kind: 'reservation', external_id: 'r1', data: {} }],
    })

    expect(result).toMatchObject({ reason: 'no_identity', records: { accepted: 0, dropped: 1 } })
    expect(passports.identify).not.toHaveBeenCalled()
  })

  it('drops facts when customer has no identity at all', async () => {
    const passports = makePassports()
    const awareness = makeAwareness()
    const ingest = setup({ passports, awareness })

    const result = await ingest.ingestFacts({
      source: 'booking',
      customer: {},
      facts: [{ id: 'f1', kind: 'note', body: 'hi' }],
    })

    expect(result).toMatchObject({ reason: 'no_identity', facts: { accepted: 0, dropped: 1 } })
    expect(awareness.record).not.toHaveBeenCalled()
  })

  it('drops on unparseable phone with no other identity (both routes)', async () => {
    const ingest = setup()
    const cust = { phone: 'not-a-phone' }
    expect((await ingest.ingestRecords({ source: 'x', customer: cust, records: [{ kind: 'k', external_id: '1', data: {} }] })).reason).toBe('no_identity')
    expect((await ingest.ingestFacts  ({ source: 'x', customer: cust, facts:   [{ id: 'f', kind: 'note', body: 'b' }] })).reason).toBe('no_identity')
  })

  it('returns empty_payload when array is missing or empty', async () => {
    const ingest = setup()
    expect((await ingest.ingestRecords({ source: 'x', customer: { email: 'a@b.com' }, records: [] })).reason).toBe('empty_payload')
    expect((await ingest.ingestFacts  ({ source: 'x', customer: { email: 'a@b.com' }, facts:   [] })).reason).toBe('empty_payload')
  })

  it('creates new passport on first sight (works for records or facts alone)', async () => {
    const passports = makePassports({ newPassportId: 'p-new' })
    const ingest = setup({ passports })

    const recResult = await ingest.ingestRecords({
      source: 'booking',
      customer: { email: 'fresh@example.com' },
      records: [{ kind: 'reservation', external_id: 'r1', data: {} }],
    })
    expect(recResult.passport_created).toBe(true)
    expect(recResult.passport_id).toBe('p-new')

    passports.byIdentity = { 'email|fresh@example.com': { id: 'p-new' } }
    passports.findByIdentity.mockImplementation(async (t, v) =>
      t === 'email' && v === 'fresh@example.com' ? { id: 'p-new' } : null)

    const factResult = await ingest.ingestFacts({
      source: 'booking',
      customer: { email: 'fresh@example.com' },
      facts: [{ id: 'f1', kind: 'note', body: 'follow-up' }],
    })
    expect(factResult.passport_created).toBe(false)
    expect(factResult.passport_id).toBe('p-new')
  })

  it('backfills identities onto an existing passport', async () => {
    const passports = makePassports({ byIdentity: { 'email|known@example.com': { id: 'p-existing' } } })
    const ingest = setup({ passports })
    await ingest.ingestFacts({
      source: 'booking',
      customer: { email: 'known@example.com', phone: '+1 555 123 4567', country: 'US' },
      facts: [{ id: 'f1', kind: 'tag', body: 'VIP' }],
    })
    expect(passports.link).toHaveBeenCalledWith('p-existing', expect.arrayContaining([
      { type: 'phone', name: 'e164', value: '+15551234567' },
    ]))
  })
})

describe('crm.ingest — ingestRecords (→ core facts via state)', () => {
  it('records each record\'s structured state with passport linkage and returns counters', async () => {
    const state = setState(makeState())
    const passports = makePassports({ byIdentity: { 'email|alice@example.com': { id: 'p-1' } } })
    const ingest = setup({ passports })

    const result = await ingest.ingestRecords({
      source: 'booking',
      customer: { email: 'alice@example.com' },
      records: [
        { kind: 'reservation', external_id: 'r1', status: 'confirmed', data: { room: 12 } },
        { kind: 'reservation', external_id: 'r2', status: 'pending', data: {} },
      ],
    })

    expect(state.record).toHaveBeenCalledTimes(2)
    expect(state.record).toHaveBeenCalledWith(expect.objectContaining({
      source: 'booking', kind: 'reservation', external_id: 'r1', passport_id: 'p-1', status: 'confirmed', data: { room: 12 },
    }))
    expect(result.records).toEqual({ accepted: 2, dropped: 0 })
    expect(result.passport_id).toBe('p-1')
  })

  it('counts a failed state write as dropped without aborting the batch', async () => {
    const state = setState(makeState())
    state.record
      .mockImplementationOnce(async () => { throw new Error('facts down') })
      .mockImplementationOnce(async (r) => ({ ...r, written: 1 }))
    const passports = makePassports({ byIdentity: { 'email|a@b.com': { id: 'p-1' } } })
    const ingest = setup({ passports })

    const result = await ingest.ingestRecords({
      source: 'booking',
      customer: { email: 'a@b.com' },
      records: [
        { kind: 'reservation', external_id: 'r1', data: {} },
        { kind: 'reservation', external_id: 'r2', data: {} },
      ],
    })

    expect(result.records).toEqual({ accepted: 1, dropped: 1 })
  })
})

describe('crm.ingest — ingestFacts (→ awareness notes)', () => {
  it('records a customer-level note (no ref) into awareness', async () => {
    const passports = makePassports({ byIdentity: { 'email|bob@example.com': { id: 'p-3' } } })
    const awareness = makeAwareness()
    const ingest = setup({ passports, awareness })

    await ingest.ingestFacts({
      source: 'hubspot',
      customer: { email: 'bob@example.com' },
      facts: [{ id: 'vip-tag', kind: 'tag', body: 'VIP — personal friend of CEO' }],
    })

    expect(awareness.record).toHaveBeenCalledWith(expect.objectContaining({
      passport_id: 'p-3',
      channel: 'crm',
      direction: 'observation',
      source: 'hubspot',
      content_id: 'hubspot:fact:tag:vip-tag',
      text: 'VIP — personal friend of CEO',
      meta: { kind: 'tag' },
    }))
  })

  it('a ref carries the external identity + entity (joins to the state facts)', async () => {
    const passports = makePassports({ byIdentity: { 'email|c@d.com': { id: 'p-1' } } })
    const awareness = makeAwareness()
    const ingest = setup({ passports, awareness })

    await ingest.ingestFacts({
      source: 'hubspot',
      customer: { email: 'c@d.com' },
      facts: [{ id: 'n-7', kind: 'note', body: 'Called, interested',
               ref: { kind: 'deal', external_id: 'd-42' } }],
    })

    const call = awareness.record.mock.calls[0][0]
    expect(call.meta).toEqual({
      kind: 'note',
      ref: { kind: 'deal', external_id: 'd-42', entity: 'deal:d-42' },
    })
    expect(call.meta.record_id).toBeUndefined()   // record_id is retired
  })

  it('content_id is stable across re-pushes and independent of ref', async () => {
    const passports = makePassports({ byIdentity: { 'email|c@d.com': { id: 'p-1' } } })
    const awareness = makeAwareness()
    const ingest = setup({ passports, awareness })

    await ingest.ingestFacts({
      source: 'hubspot', customer: { email: 'c@d.com' },
      facts: [{ id: 'n-7', kind: 'note', body: 'Same body', ref: { kind: 'deal', external_id: 'A' } }],
    })
    await ingest.ingestFacts({
      source: 'hubspot', customer: { email: 'c@d.com' },
      facts: [{ id: 'n-7', kind: 'note', body: 'Same body', ref: { kind: 'deal', external_id: 'B' } }],
    })

    expect(awareness.record.mock.calls[0][0].content_id).toBe('hubspot:fact:note:n-7')
    expect(awareness.record.mock.calls[1][0].content_id).toBe('hubspot:fact:note:n-7')
  })

  it('skips facts without a body, counts them as dropped', async () => {
    const passports = makePassports({ byIdentity: { 'email|c@d.com': { id: 'p-1' } } })
    const awareness = makeAwareness()
    const ingest = setup({ passports, awareness })

    const result = await ingest.ingestFacts({
      source: 'x', customer: { email: 'c@d.com' },
      facts: [
        { id: '1', kind: 'note', body: 'good' },
        { id: '2', kind: 'note', body: '' },
      ],
    })

    expect(result.facts.accepted).toBe(1)
    expect(awareness.record).toHaveBeenCalledOnce()
  })
})

describe('ingestObservations (client-reported, low-trust)', () => {
  it('records each observation as a client-tagged crm/observation', async () => {
    const awareness = makeAwareness()
    setup({ awareness })

    const out = await ingest.ingestObservations({
      passport_id: 'p-1',
      observations: [
        { id: 'o1', kind: 'onboarding_step', body: 'completed step 3' },
        { id: 'o2', kind: 'cart', body: 'added 2 items', meta: { count: 2 } },
      ],
    })

    expect(out.observations).toEqual({ accepted: 2, dropped: 0 })
    expect(awareness.record).toHaveBeenCalledTimes(2)
    expect(awareness.record).toHaveBeenCalledWith(expect.objectContaining({
      passport_id: 'p-1',
      channel: 'crm',
      direction: 'observation',
      source: 'client',
      content_id: 'client:obs:onboarding_step:o1',
      text: 'completed step 3',
      meta: expect.objectContaining({ kind: 'onboarding_step', client: true }),
    }))
  })

  it('drops everything when there is no passport_id', async () => {
    const awareness = makeAwareness()
    setup({ awareness })
    const out = await ingest.ingestObservations({ observations: [{ id: 'o1', kind: 'k', body: 'b' }] })
    expect(out).toMatchObject({ reason: 'no_identity', observations: { accepted: 0, dropped: 1 } })
    expect(awareness.record).not.toHaveBeenCalled()
  })

  it('skips observations without a body', async () => {
    const awareness = makeAwareness()
    setup({ awareness })
    const out = await ingest.ingestObservations({ passport_id: 'p-1', observations: [{ id: 'o1', kind: 'k' }] })
    expect(out.observations.accepted).toBe(0)
    expect(awareness.record).not.toHaveBeenCalled()
  })
})
