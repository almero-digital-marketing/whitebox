import { describe, it, expect, vi, beforeEach } from 'vitest'
import crmPlugin from '../src/index.js'

function makeCore({ connected = true, consent = null } = {}) {
  const transport = { isConnected: () => connected, send: vi.fn(() => true) }
  const http = { request: vi.fn(async () => ({})), beacon: vi.fn(() => true) }
  const attached = {}
  const core = {
    transport,
    http,
    consent,
    logger: { warn: vi.fn() },
    getPassportId: () => 'pid-1',
    attach: (name, api) => { attached[name] = api },
  }
  return { core, transport, http, attached }
}

function install(opts = {}, coreOpts = {}) {
  const env = makeCore(coreOpts)
  crmPlugin(opts).install(env.core)
  return { ...env, crm: env.attached.crm }
}

describe('crm client plugin', () => {
  beforeEach(() => { vi.useRealTimers() })

  it('attaches an observe() + flush() api', () => {
    const { crm } = install()
    expect(typeof crm.observe).toBe('function')
    expect(typeof crm.flush).toBe('function')
  })

  it('flushes over the socket when connected (no HTTP)', () => {
    const { crm, transport, http } = install({ batchSize: 2 })
    crm.observe({ kind: 'onboarding_step', body: 'completed step 3' })
    crm.observe({ kind: 'cart', body: 'added 2 items' })   // hits batchSize → flush
    expect(transport.send).toHaveBeenCalledTimes(1)
    const [event, payload] = transport.send.mock.calls[0]
    expect(event).toBe('crm.observe')
    expect(payload.observations).toHaveLength(2)
    expect(payload.observations[0]).toMatchObject({ kind: 'onboarding_step', body: 'completed step 3' })
    expect(payload.observations[0].id).toBeDefined()       // auto-generated id
    expect(http.request).not.toHaveBeenCalled()
  })

  it('falls back to HTTP /crm/observe with explicit passport_id when the socket is down', () => {
    const { crm, http } = install({ batchSize: 1 }, { connected: false })
    crm.observe({ kind: 'cta', body: 'clicked upgrade' })
    expect(http.request).toHaveBeenCalledWith('/crm/observe', expect.objectContaining({
      method: 'POST',
      body: expect.objectContaining({ passport_id: 'pid-1', observations: expect.any(Array) }),
    }))
  })

  it('drops observations missing kind/body', () => {
    const { crm, transport } = install({ batchSize: 1 })
    crm.observe({ body: 'no kind' })
    crm.observe({ kind: 'no-body' })
    expect(transport.send).not.toHaveBeenCalled()
  })

  it('is consent-gated when a category is configured', () => {
    const consent = { has: vi.fn(() => false) }
    const { crm, transport } = install({ batchSize: 1, consent: 'marketing' }, { consent })
    crm.observe({ kind: 'cta', body: 'clicked upgrade' })
    expect(consent.has).toHaveBeenCalledWith('marketing')
    expect(transport.send).not.toHaveBeenCalled()        // dropped — no consent

    consent.has.mockReturnValue(true)
    crm.observe({ kind: 'cta', body: 'clicked again' })
    expect(transport.send).toHaveBeenCalledTimes(1)       // now allowed
  })

  it('beacon-flushes buffered observations on pagehide', () => {
    const { crm, http } = install({ batchSize: 99 })       // large batch → stays buffered
    crm.observe({ kind: 'cart', body: 'added item' })
    window.dispatchEvent(new Event('pagehide'))
    expect(http.beacon).toHaveBeenCalledWith('/crm/observe', expect.objectContaining({
      passport_id: 'pid-1',
      observations: expect.arrayContaining([expect.objectContaining({ kind: 'cart' })]),
    }))
  })
})
