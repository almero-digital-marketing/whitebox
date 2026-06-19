import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { meta as server } from '../src/index.js'
import { meta as client } from '../src/client.js'

describe('meta server (CAPI)', () => {
  it('is eligible only with creds', () => {
    expect(server({}).eligible).toBe(false)
    expect(server({ pixelId: 'P', accessToken: 'T' }).eligible).toBe(true)
  })

  it('maps the canonical event + hashed ids + signals into the CAPI body', async () => {
    let body
    globalThis.fetch = async (_url, opts) => { body = JSON.parse(opts.body); return { ok: true, json: async () => ({}) } }
    const res = await server({ pixelId: 'P', accessToken: 'T' }).sendEvent(
      { standard: 'purchase', event_id: 'e1', ts: '2026-06-18T00:00:00Z', value: 10, currency: 'USD', content_ids: ['s'] },
      { email_sha256: 'H', external_id: 'cust', signals: { fbp: 'fb.1' }, ip: '1.2.3.4', user_agent: 'UA' })
    expect(res.status).toBe('accepted')
    expect(body.data[0].event_name).toBe('Purchase')
    expect(body.data[0].user_data).toMatchObject({ em: 'H', external_id: 'cust', fbp: 'fb.1', client_ip_address: '1.2.3.4' })
    expect(body.data[0].custom_data).toMatchObject({ value: 10, currency: 'USD', content_ids: ['s'] })
  })
})

describe('meta client (pixel)', () => {
  beforeEach(() => { window.fbq = vi.fn() })
  afterEach(() => { delete window.fbq })

  it('fires fbq with the mapped payload + shared eventID', () => {
    client().fire('standard', 'purchase', { value: 5, currency: 'USD', content_ids: ['x'] }, 'E1')
    expect(window.fbq).toHaveBeenCalledWith('track', 'Purchase',
      expect.objectContaining({ value: 5, currency: 'USD', content_ids: ['x'] }), { eventID: 'E1' })
  })

  it('routes a custom event via trackCustom', () => {
    client().fire('custom', 'wb_x', {}, 'E2')
    expect(window.fbq).toHaveBeenCalledWith('trackCustom', 'wb_x', expect.any(Object), { eventID: 'E2' })
  })

  it('collects _fbp', () => {
    document.cookie = '_fbp=fb.1.collect'
    expect(client().collect().fbp).toBe('fb.1.collect')
  })
})
