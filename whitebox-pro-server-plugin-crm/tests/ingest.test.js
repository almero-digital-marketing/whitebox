import { describe, it, expect, vi, beforeEach } from 'vitest'

// ingest now imports the real records module directly (`import * as records`).
// Mock it so each test can swap in a fresh stub whose upsert/find calls the
// existing assertions still inspect. The mock's exported functions delegate to
// whatever stub the test installed via setRecords(makeRecords()).
let currentRecords
vi.mock('../src/records.js', () => ({
  init: vi.fn(),
  upsert: vi.fn((...args) => currentRecords.upsert(...args)),
  find: vi.fn((...args) => currentRecords.find(...args)),
  listForPassport: vi.fn((...args) => currentRecords.listForPassport(...args)),
}))

import * as ingest from '../src/ingest.js'
import * as records from '../src/records.js'

function makeRecords() {
  const store = []
  return {
    _store: store,
    upsert: vi.fn(async (r) => {
      const idx = store.findIndex(x => x.source === r.source && x.kind === r.kind && x.external_id === r.external_id)
      const row = { id: idx >= 0 ? store[idx].id : store.length + 1, updated_at: new Date(), ...r }
      if (idx >= 0) store[idx] = row
      else store.push(row)
      return row
    }),
    find: vi.fn(async ({ source, kind, external_id }) =>
      store.find(r => r.source === source && r.kind === kind && r.external_id === String(external_id)) ?? null),
  }
}

// Install a records stub as the active delegate and re-init the ingest
// singleton with fresh passports/awareness. Returns the ingest namespace so
// existing `ingest.ingestRecords()` call sites are unchanged.
function setup({ passports, awareness } = {}) {
  passports ??= makePassports()
  awareness ??= makeAwareness()
  ingest.init({ passports, awareness, logger })
  return ingest
}

function setRecords(stub) {
  currentRecords = stub
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

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

beforeEach(() => {
  vi.clearAllMocks()
  setRecords(makeRecords())
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

    // Second call with the same email reuses the (now-existing) passport.
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

describe('crm.ingest — ingestRecords', () => {
  it('upserts records with passport linkage and returns counters', async () => {
    const records = setRecords(makeRecords())
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

    expect(records.upsert).toHaveBeenCalledTimes(2)
    expect(result.records).toEqual({ accepted: 2, dropped: 0 })
    expect(result.passport_id).toBe('p-1')
  })

  it('counts a failed upsert as dropped without aborting the batch', async () => {
    const records = setRecords(makeRecords())
    records.upsert
      .mockImplementationOnce(async () => { throw new Error('db down') })
      .mockImplementationOnce(async (r) => ({ id: 1, ...r }))
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

describe('crm.ingest — ingestFacts', () => {
  it('records a customer-level fact (no ref) into awareness', async () => {
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

  it('resolves ref to record_id via DB lookup when the record exists', async () => {
    const records = setRecords(makeRecords())
    // Pre-seed: the referenced record was upserted in an earlier request.
    records._store.push({
      id: 42, source: 'hubspot', kind: 'deal', external_id: 'd-42',
      passport_id: 'p-1', data: {},
    })
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
      ref: { kind: 'deal', external_id: 'd-42' },
      record_id: 42,
    })
    expect(records.find).toHaveBeenCalledWith({
      source: 'hubspot', kind: 'deal', external_id: 'd-42',
    })
  })

  it('omits record_id but keeps ref when the referenced record is not (yet) stored', async () => {
    const passports = makePassports({ byIdentity: { 'email|c@d.com': { id: 'p-1' } } })
    const awareness = makeAwareness()
    const ingest = setup({ passports, awareness })

    await ingest.ingestFacts({
      source: 'hubspot',
      customer: { email: 'c@d.com' },
      facts: [{ id: 'n-7', kind: 'note', body: 'Status changed',
               ref: { kind: 'deal', external_id: 'd-42' } }],
    })

    const call = awareness.record.mock.calls[0][0]
    expect(call.meta.ref).toEqual({ kind: 'deal', external_id: 'd-42' })
    expect(call.meta.record_id).toBeUndefined()
  })

  it('content_id is stable across re-pushes and independent of ref', async () => {
    const passports = makePassports({ byIdentity: { 'email|c@d.com': { id: 'p-1' } } })
    const awareness = makeAwareness()
    const ingest = setup({ passports, awareness })

    // Same fact, referenced against two different records — content_id stays put.
    await ingest.ingestFacts({
      source: 'hubspot', customer: { email: 'c@d.com' },
      facts: [{ id: 'n-7', kind: 'note', body: 'Same body',
               ref: { kind: 'deal', external_id: 'A' } }],
    })
    await ingest.ingestFacts({
      source: 'hubspot', customer: { email: 'c@d.com' },
      facts: [{ id: 'n-7', kind: 'note', body: 'Same body',
               ref: { kind: 'deal', external_id: 'B' } }],
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
        { id: '2', kind: 'note', body: '' },          // would already be 400 at Zod, this is a safety net
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
