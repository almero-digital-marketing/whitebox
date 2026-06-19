import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tiktok as server } from '../src/index.js'
import { tiktok as client } from '../src/client.js'

describe('tiktok server (Events API)', () => {
  it('is eligible only with creds', () => {
    expect(server({}).eligible).toBe(false)
    expect(server({ pixelCode: 'C', accessToken: 'T' }).eligible).toBe(true)
  })

  it('maps the canonical event + user into the Events API body', async () => {
    let body
    globalThis.fetch = async (_url, opts) => { body = JSON.parse(opts.body); return { ok: true, json: async () => ({ code: 0 }) } }
    const res = await server({ pixelCode: 'C', accessToken: 'T' }).sendEvent(
      { standard: 'purchase', event_id: 'e1', ts: '2026-06-18T00:00:00Z', value: 9, currency: 'USD', content_ids: ['s'] },
      { email_sha256: 'H', signals: { ttp: 'ttpX' }, ip: '1.1.1.1', user_agent: 'UA' })
    expect(res.status).toBe('accepted')
    expect(body.event_source_id).toBe('C')
    expect(body.data[0].event).toBe('CompletePayment')
    expect(body.data[0].user).toMatchObject({ email: 'H', ttp: 'ttpX', ip: '1.1.1.1' })
    expect(body.data[0].properties).toMatchObject({ value: 9, currency: 'USD', content_id: 's' })
  })

  it('rejects on a non-zero code', async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ code: 40000, message: 'bad' }) })
    const res = await server({ pixelCode: 'C', accessToken: 'T' }).sendEvent({ standard: 'lead', event_id: 'e2' }, {})
    expect(res.status).toBe('rejected')
  })
})

describe('tiktok client (pixel)', () => {
  beforeEach(() => { window.ttq = { track: vi.fn() } })
  afterEach(() => { delete window.ttq })

  it('fires ttq.track with the mapped payload + shared event_id', () => {
    client().fire('standard', 'add_to_cart', { value: 3, currency: 'USD', content_ids: ['x'] }, 'E1')
    expect(window.ttq.track).toHaveBeenCalledWith('AddToCart',
      expect.objectContaining({ value: 3, currency: 'USD' }), { event_id: 'E1' })
  })

  it('collects _ttp', () => {
    document.cookie = '_ttp=ttp-collect'
    expect(client().collect().ttp).toBe('ttp-collect')
  })
})
