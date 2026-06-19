import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import conversionsPlugin from '../src/index.js'
import { meta } from 'whitebox-adnetworks-meta/client'
import { google } from 'whitebox-adnetworks-google/client'
import { tiktok } from 'whitebox-adnetworks-tiktok/client'

// Compose the real per-network client packages; the demo/app does the same.
function setup({ consented = true, networks, sst } = {}) {
  const requests = []
  const core = {
    http: { request: vi.fn(async (path, opts) => { requests.push({ path, opts }); return {} }) },
    queue: (fn) => fn(),
    consent: { has: vi.fn(() => consented) },
    logger: { debug: vi.fn(), warn: vi.fn() },
    getPassportId: () => 'p-123',
    attach: vi.fn(),
  }
  const opts = { networks: networks ?? [meta(), google(), tiktok()] }
  if (sst !== undefined) opts.sst = sst
  conversionsPlugin(opts).install(core)
  return { api: core.attach.mock.calls[0][1], requests, core }
}

beforeEach(() => {
  window.fbq = vi.fn()
  window.gtag = vi.fn()
  window.ttq = { track: vi.fn() }
})
afterEach(() => { delete window.fbq; delete window.gtag; delete window.ttq })

describe('composed pixels — firing + mapping', () => {
  it('fires meta/google/tiktok for a purchase with the shared event_id', async () => {
    const { api, requests } = setup()
    const { event_id, pixels } = await api.purchase({ value: 49.99, currency: 'USD', content_ids: ['sku-1'], num_items: 2 })

    expect(pixels.sort()).toEqual(['google', 'meta', 'tiktok'])
    expect(window.fbq).toHaveBeenCalledWith('track', 'Purchase',
      expect.objectContaining({ value: 49.99, currency: 'USD', content_ids: ['sku-1'], content_type: 'product' }), { eventID: event_id })
    expect(window.ttq.track).toHaveBeenCalledWith('CompletePayment',
      expect.objectContaining({ value: 49.99, currency: 'USD' }), { event_id })
    expect(window.gtag).toHaveBeenCalledWith('event', 'purchase', expect.objectContaining({ value: 49.99, currency: 'USD' }))
    expect(requests[0].opts.body.events[0].event_id).toBe(event_id)
  })

  it('maps content_ids into per-network item shapes', async () => {
    const { api } = setup()
    await api.viewContent({ content_ids: ['a', 'b'] })
    expect(window.fbq).toHaveBeenCalledWith('track', 'ViewContent',
      expect.objectContaining({ content_ids: ['a', 'b'], contents: [{ id: 'a', quantity: 1 }, { id: 'b', quantity: 1 }] }), expect.any(Object))
    expect(window.gtag).toHaveBeenCalledWith('event', 'view_item',
      expect.objectContaining({ items: [{ item_id: 'a' }, { item_id: 'b' }] }))
  })

  it('routes custom events through each network custom path', async () => {
    const { api } = setup()
    await api.custom('wb_high_intent', { value: 1 })
    expect(window.fbq).toHaveBeenCalledWith('trackCustom', 'wb_high_intent', expect.any(Object), expect.any(Object))
    expect(window.ttq.track).toHaveBeenCalledWith('wb_high_intent', expect.any(Object), expect.any(Object))
    expect(window.gtag).toHaveBeenCalledWith('event', 'wb_high_intent', expect.any(Object))
  })

  it('skips a pixel that is not present (no throw)', async () => {
    delete window.ttq
    const { api } = setup()
    const { pixels } = await api.lead({})
    expect(pixels.sort()).toEqual(['google', 'meta'])
  })

  it('only fires the composed networks', async () => {
    const { api } = setup({ networks: [meta()] })
    const { pixels } = await api.lead({})
    expect(pixels).toEqual(['meta'])
    expect(window.gtag).not.toHaveBeenCalled()
    expect(window.ttq.track).not.toHaveBeenCalled()
  })

  it('fires no pixels and no POST when consent is withheld', async () => {
    const { api, requests } = setup({ consented: false })
    const res = await api.purchase({ value: 1, currency: 'USD' })
    expect(res).toEqual({ skipped: 'consent' })
    expect(window.fbq).not.toHaveBeenCalled()
    expect(requests).toHaveLength(0)
  })

  it('sst:false fires pixels only, no server POST', async () => {
    const { api, requests } = setup({ sst: false })
    const { pixels } = await api.search({ search_string: 'whitening' })
    expect(pixels.length).toBe(3)
    expect(window.fbq).toHaveBeenCalledWith('track', 'Search', expect.objectContaining({ search_string: 'whitening' }), expect.any(Object))
    expect(requests).toHaveLength(0)
  })

  it('threads transaction_id into the gtag purchase (GA4 dedup) and the server hit', async () => {
    const { api, requests } = setup()
    await api.purchase({ value: 10, currency: 'USD', transaction_id: 'ORD-42' })
    expect(window.gtag).toHaveBeenCalledWith('event', 'purchase', expect.objectContaining({ transaction_id: 'ORD-42' }))
    expect(requests[0].opts.body.events[0].transaction_id).toBe('ORD-42')
  })

  it('collects each network\'s browser signals and sends them in the POST', async () => {
    document.cookie = '_ga=GA1.1.1234567890.1681000000'
    document.cookie = '_fbp=fb.1.1681000000.987654321'
    const { api, requests } = setup()
    await api.lead({})
    const sig = requests[0].opts.body.signals
    expect(sig.ga_client_id).toBe('1234567890.1681000000')   // google.collect()
    expect(sig.fbp).toBe('fb.1.1681000000.987654321')        // meta.collect()
  })

  it('only collects signals for the composed networks', async () => {
    document.cookie = '_ga=GA1.1.111.222'
    document.cookie = '_fbp=fb.1.5.9'
    const { api, requests } = setup({ networks: [meta()] })
    await api.lead({})
    const sig = requests[0].opts.body.signals
    expect(sig.fbp).toBe('fb.1.5.9')         // meta collected
    expect(sig.ga_client_id).toBeUndefined() // google not composed
  })
})
