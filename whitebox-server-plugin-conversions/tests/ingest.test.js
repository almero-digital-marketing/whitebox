import { describe, it, expect, vi, beforeEach } from 'vitest'

// Replace the audit store with spies — no DB needed for the core logic.
vi.mock('../src/store.js', () => ({
  init: vi.fn(),
  seen: vi.fn(async () => null),
  insert: vi.fn(async (r) => ({ id: 1, ...r })),
  listForPassport: vi.fn(async () => []),
  list: vi.fn(async () => []),
}))

import * as store from '../src/store.js'
import * as ingest from '../src/ingest.js'

const PID = 'p-123'

function setup({ consent = true } = {}) {
  const awareness = { record: vi.fn(async () => {}) }
  const reporter = { report: vi.fn(async () => ({ meta: 'skipped', google: 'skipped', tiktok: 'skipped' })) }
  const consentOk = vi.fn(async () => consent)
  ingest.init({ awareness, reporter, consentOk, logger: { warn: vi.fn() } })
  return { awareness, reporter, consentOk }
}

beforeEach(() => {
  vi.clearAllMocks()
  store.seen.mockResolvedValue(null)
  store.insert.mockImplementation(async (r) => ({ id: 1, ...r }))
})

describe('ingestEvent', () => {
  it('records a first-party signal and fans out a valid purchase', async () => {
    const { awareness, reporter } = setup()
    const r = await ingest.ingestEvent(PID, {
      standard: 'purchase', event_id: 'e1', ts: '2026-06-18T00:00:00Z',
      url: 'https://shop/checkout', value: 49.99, currency: 'USD', content_ids: ['sku1'], num_items: 2,
      transaction_id: 'ORD-9',
    })

    expect(r).toMatchObject({ event_id: 'e1', name: 'purchase', status: 'recorded' })

    expect(awareness.record).toHaveBeenCalledOnce()
    const rec = awareness.record.mock.calls[0][0]
    expect(rec).toMatchObject({ passport_id: PID, channel: 'web', direction: 'conversion', content_id: 'conversion:purchase:e1' })
    expect(rec.text).toContain('purchase')

    expect(reporter.report).toHaveBeenCalledOnce()
    const canonical = reporter.report.mock.calls[0][1]
    expect(canonical).toMatchObject({ standard: 'purchase', event_id: 'e1', value: 49.99, currency: 'USD', content_ids: ['sku1'], num_items: 2, transaction_id: 'ORD-9' })

    expect(store.insert).toHaveBeenCalledOnce()
    expect(store.insert.mock.calls[0][0]).toMatchObject({ passport_id: PID, event_id: 'e1', name: 'purchase', kind: 'standard' })
  })

  it('generates an event_id when the client omits it', async () => {
    setup()
    const r = await ingest.ingestEvent(PID, { standard: 'page_view' })
    expect(r.event_id).toBeTruthy()
    expect(r.status).toBe('recorded')
  })

  it('is idempotent by event_id (duplicate beacon)', async () => {
    const { awareness, reporter } = setup()
    store.seen.mockResolvedValue({ event_id: 'e1', networks: { meta: 'accepted' } })
    const r = await ingest.ingestEvent(PID, { standard: 'lead', event_id: 'e1' })
    expect(r.status).toBe('duplicate')
    expect(r.networks).toEqual({ meta: 'accepted' })
    expect(awareness.record).not.toHaveBeenCalled()
    expect(reporter.report).not.toHaveBeenCalled()
    expect(store.insert).not.toHaveBeenCalled()
  })

  it('still records but skips fan-out when consent is withheld', async () => {
    const { awareness, reporter } = setup({ consent: false })
    const r = await ingest.ingestEvent(PID, { standard: 'lead', event_id: 'e2' })
    expect(awareness.record).toHaveBeenCalledOnce()
    expect(reporter.report).not.toHaveBeenCalled()
    expect(r.networks).toEqual({ skipped: 'consent' })
  })

  it('handles a custom (non-standard) event', async () => {
    const { reporter } = setup()
    await ingest.ingestEvent(PID, { event: 'wb_high_intent', event_id: 'e3', meta: { tier: 'gold' } })
    const canonical = reporter.report.mock.calls[0][1]
    expect(canonical.event).toBe('wb_high_intent')
    expect(canonical.standard).toBeUndefined()
  })

  it('throws on an event with no name', async () => {
    setup()
    await expect(ingest.ingestEvent(PID, { value: 1 })).rejects.toThrow(/standard.*or.*event/)
  })
})

describe('ingestBatch', () => {
  it('processes each event independently — one bad event does not sink the rest', async () => {
    const { awareness } = setup()
    const results = await ingest.ingestBatch(PID, [
      { standard: 'purchase', event_id: 'ok', value: 10, currency: 'USD' },
      { standard: 'purchase', event_id: 'bad' },              // missing value/currency
      { standard: 'view_content', event_id: 'ok2', content_ids: ['a'] },
    ])
    expect(results.map(r => r.status)).toEqual(['recorded', 'invalid', 'recorded'])
    expect(results[1].error).toMatch(/invalid payload/)
    expect(awareness.record).toHaveBeenCalledTimes(2)
  })
})
