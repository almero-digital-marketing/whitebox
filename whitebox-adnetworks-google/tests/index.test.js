import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { google as server } from '../src/index.js'
import { google as client } from '../src/client.js'

describe('google server (GA4 MP)', () => {
  it('is eligible only with creds', () => {
    expect(server({}).eligible).toBe(false)
    expect(server({ measurementId: 'G', apiSecret: 'S' }).eligible).toBe(true)
  })

  it('rejects without the ga_client_id signal', async () => {
    const res = await server({ measurementId: 'G', apiSecret: 'S' }).sendEvent({ standard: 'purchase', event_id: 'e1' }, { signals: {} })
    expect(res.status).toBe('rejected')
  })

  it('maps to MP with client_id + transaction_id', async () => {
    let body
    globalThis.fetch = async (_url, opts) => { body = JSON.parse(opts.body); return { ok: true } }
    const res = await server({ measurementId: 'G', apiSecret: 'S' }).sendEvent(
      { standard: 'purchase', event_id: 'e1', value: 10, currency: 'USD', transaction_id: 'T1' },
      { external_id: 'cust', signals: { ga_client_id: '11.22' } })
    expect(res.status).toBe('accepted')
    expect(body.client_id).toBe('11.22')
    expect(body.user_id).toBe('cust')
    expect(body.events[0]).toMatchObject({ name: 'purchase' })
    expect(body.events[0].params).toMatchObject({ value: 10, currency: 'USD', transaction_id: 'T1' })
  })
})

describe('google client (gtag)', () => {
  beforeEach(() => { window.gtag = vi.fn() })
  afterEach(() => { delete window.gtag })

  it('fires gtag with the GA4 event name (no id — GA4 has no pixel↔MP dedup)', () => {
    client().fire('standard', 'view_content', { content_ids: ['a'] })
    expect(window.gtag).toHaveBeenCalledWith('event', 'view_item', expect.objectContaining({ items: [{ item_id: 'a' }] }))
  })

  it('parses _ga into ga_client_id', () => {
    document.cookie = '_ga=GA1.1.333.444'
    expect(client().collect().ga_client_id).toBe('333.444')
  })
})
