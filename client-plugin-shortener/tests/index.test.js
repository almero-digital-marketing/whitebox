import { describe, it, expect, vi, beforeEach } from 'vitest'
import shortenerPlugin from '../src/index.js'

function makeCore({ claim } = {}) {
  let passportId = 'anon-1'
  const core = {
    http: { request: vi.fn(async () => claim) },
    getPassportId: () => passportId,
    setPassportId: vi.fn(id => { passportId = id }),
    attach: vi.fn(),
    logger: { warn: vi.fn() },
    _passport: () => passportId,
  }
  return core
}

function setUrl(href) {
  // cross-origin setup needs happy-dom's setURL (replaceState would throw);
  // the plugin's own same-origin scrub still uses history.replaceState.
  window.happyDOM.setURL(href)
}

beforeEach(() => setUrl('https://clinic.com/whitening'))

describe('shortener client plugin', () => {
  it('does nothing (no claim) when there is no token in the URL', async () => {
    const core = makeCore()
    await shortenerPlugin().install(core)
    expect(core.http.request).not.toHaveBeenCalled()
    expect(core.attach).toHaveBeenCalledWith('shortener', { data: null })
  })

  it('reads a #wb= token, claims, adopts the passport, exposes prefill, scrubs the URL', async () => {
    setUrl('https://clinic.com/whitening#wb=TOK123')
    const core = makeCore({ claim: { bound: true, passport_id: 'jane', data: { name: 'Jane' } } })
    await shortenerPlugin().install(core)

    expect(core.http.request).toHaveBeenCalledWith('/shortener/claim',
      { method: 'POST', body: { token: 'TOK123', passport_id: 'anon-1' } })
    expect(core.setPassportId).toHaveBeenCalledWith('jane')
    expect(core._passport()).toBe('jane')
    expect(core.attach).toHaveBeenCalledWith('shortener', { data: { name: 'Jane' }, bound: true })
    expect(location.href).toBe('https://clinic.com/whitening')   // token scrubbed
  })

  it('reads a ?wb= token (query handoff)', async () => {
    setUrl('https://clinic.com/app?wb=TOK456#/whitening')
    const core = makeCore({ claim: { bound: true, passport_id: 'jane', data: {} } })
    await shortenerPlugin().install(core)
    expect(core.http.request).toHaveBeenCalledWith('/shortener/claim',
      expect.objectContaining({ body: { token: 'TOK456', passport_id: 'anon-1' } }))
    expect(location.href).toBe('https://clinic.com/app#/whitening')   // only the wb param dropped
  })

  it('does not adopt a passport when the claim is unbound', async () => {
    setUrl('https://clinic.com/x#wb=STALE')
    const core = makeCore({ claim: { bound: false } })
    await shortenerPlugin().install(core)
    expect(core.setPassportId).not.toHaveBeenCalled()
    expect(core.attach).toHaveBeenCalledWith('shortener', { data: null, bound: false })
  })
})
