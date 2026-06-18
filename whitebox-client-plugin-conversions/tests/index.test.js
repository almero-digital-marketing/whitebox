import { describe, it, expect, vi } from 'vitest'
import conversionsPlugin from '../src/index.js'

// Build a fake client core and install the plugin; return the attached API plus
// the captured /conversions/events requests.
function setup({ consented = true, requireConsent } = {}) {
  const requests = []
  const core = {
    http: { request: vi.fn(async (path, opts) => { requests.push({ path, opts }); return {} }) },
    queue: (fn) => fn(),                          // run inline
    consent: { has: vi.fn(() => consented) },
    logger: { debug: vi.fn(), warn: vi.fn() },
    getPassportId: () => 'p-123',
    attach: vi.fn(),
  }
  conversionsPlugin(requireConsent === undefined ? {} : { requireConsent }).install(core)
  const api = core.attach.mock.calls[0][1]
  return { api, requests, core }
}

const STANDARD_METHODS = [
  'pageView', 'viewContent', 'search', 'addToCart', 'addToWishlist',
  'beginCheckout', 'addPaymentInfo', 'purchase', 'lead',
  'completeRegistration', 'subscribe', 'contact',
]

describe('conversions plugin — method surface', () => {
  it('attaches one method per standard event plus track/custom', () => {
    const { api, core } = setup()
    expect(core.attach).toHaveBeenCalledWith('conversions', expect.any(Object))
    for (const m of STANDARD_METHODS) expect(typeof api[m]).toBe('function')
    expect(typeof api.track).toBe('function')
    expect(typeof api.custom).toBe('function')
  })
})

describe('conversions plugin — validation', () => {
  it('purchase sends a well-formed event with value + currency', async () => {
    const { api, requests } = setup()
    const { event_id } = await api.purchase({ value: 49.99, currency: 'USD', content_ids: ['sku-1'], num_items: 2 })

    expect(requests).toHaveLength(1)
    expect(requests[0].path).toBe('/conversions/events')
    const body = requests[0].opts.body
    expect(body.passport_id).toBe('p-123')
    expect(body.events).toHaveLength(1)
    const ev = body.events[0]
    expect(ev).toMatchObject({ standard: 'purchase', value: 49.99, currency: 'USD', content_ids: ['sku-1'], num_items: 2 })
    expect(ev.event_id).toBeTruthy()
    expect(ev.event_id).toBe(event_id)
    expect(typeof ev.ts).toBe('string')
  })

  it('purchase throws when value/currency are missing (no request sent)', async () => {
    const { api, requests } = setup()
    expect(() => api.purchase({ content_ids: ['x'] })).toThrow(/invalid payload/)
    expect(requests).toHaveLength(0)
  })

  it('rejects wrong field types', () => {
    const { api } = setup()
    expect(() => api.purchase({ value: 'free', currency: 'USD' })).toThrow(/value/)
    expect(() => api.addToCart({ content_ids: 'sku-1' })).toThrow(/content_ids/)
  })

  it('strips unknown keys, keeps meta passthrough', async () => {
    const { api, requests } = setup()
    await api.viewContent({ content_ids: ['a'], typo_field: 1, meta: { source: 'pdp' } })
    const ev = requests[0].opts.body.events[0]
    expect(ev.typo_field).toBeUndefined()
    expect(ev.meta).toEqual({ source: 'pdp' })
    expect(ev.standard).toBe('view_content')
  })

  it('honors a caller-supplied event_id (pixel dedup)', async () => {
    const { api, requests } = setup()
    await api.lead({ event_id: 'fixed-123' })
    expect(requests[0].opts.body.events[0].event_id).toBe('fixed-123')
  })
})

describe('conversions plugin — generics', () => {
  it('track(standard, payload) validates and sends', async () => {
    const { api, requests } = setup()
    await api.track('add_to_cart', { content_ids: ['z'] })
    expect(requests[0].opts.body.events[0].standard).toBe('add_to_cart')
  })

  it('track rejects an unknown standard event', () => {
    const { api } = setup()
    expect(() => api.track('frobnicate', {})).toThrow(/unknown standard event/)
  })

  it('custom(name, payload) sends a non-standard event', async () => {
    const { api, requests } = setup()
    await api.custom('wb_high_intent', { value: 1, meta: { tier: 'gold' } })
    const ev = requests[0].opts.body.events[0]
    expect(ev.event).toBe('wb_high_intent')
    expect(ev.standard).toBeUndefined()
    expect(ev.meta).toEqual({ tier: 'gold' })
  })

  it('custom requires a name', () => {
    const { api } = setup()
    expect(() => api.custom('', {})).toThrow(/name/)
  })
})

describe('conversions plugin — consent', () => {
  it('skips the send when marketing consent is not granted', async () => {
    const { api, requests, core } = setup({ consented: false })
    const res = await api.purchase({ value: 10, currency: 'USD' })
    expect(res).toEqual({ skipped: 'consent' })
    expect(requests).toHaveLength(0)
    expect(core.consent.has).toHaveBeenCalledWith('marketing')
  })

  it('sends regardless when requireConsent is false', async () => {
    const { api, requests } = setup({ consented: false, requireConsent: false })
    await api.purchase({ value: 10, currency: 'USD' })
    expect(requests).toHaveLength(1)
  })
})
