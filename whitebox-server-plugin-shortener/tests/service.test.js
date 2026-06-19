import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/store.js', () => ({
  init: vi.fn(),
  insertLink: vi.fn(async (r) => ({ id: 1, click_count: 0, ...r })),
  getLink: vi.fn(async () => null),
  bumpClicks: vi.fn(async () => 1),
  consumeIdentity: vi.fn(async () => 1),
  listLinks: vi.fn(async () => []),
  insertClick: vi.fn(async (r) => ({ id: 1, ...r })),
  getClick: vi.fn(async () => null),
  claimToken: vi.fn(async () => 1),
  setClickPassport: vi.fn(async () => 1),
  clickStats: vi.fn(async () => ({ total: 0, claimed: 0, last_at: null })),
}))
vi.mock('../src/codes.js', () => ({
  newCode: vi.fn(() => 'CODE1234'),
  newClaimToken: vi.fn(() => 'TOKEN-XYZ'),
}))

import * as store from '../src/store.js'
import * as service from '../src/service.js'

const config = {
  baseUrl: 'https://go.clinic.com', host: 'go.clinic.com', param: 'wb',
  codeLength: 8, defaultTtlSec: 100, identityTtlSec: 100, claimTtlSec: 180,
}

function setup() {
  const passports = {
    resolve: vi.fn(async (id) => id),
    identify: vi.fn(async () => 'minted'),
    findByIdentity: vi.fn(async () => null),
    link: vi.fn(async () => {}),
    merge: vi.fn(async () => {}),
  }
  const awareness = { record: vi.fn(async () => {}) }
  service.init({ passports, awareness, logger: { warn() {}, error() {} }, config })
  return { passports, awareness }
}

beforeEach(() => {
  vi.clearAllMocks()
  store.getLink.mockResolvedValue(null)
  store.getClick.mockResolvedValue(null)
  store.claimToken.mockResolvedValue(1)
  store.insertLink.mockImplementation(async (r) => ({ id: 1, click_count: 0, ...r }))
  store.insertClick.mockImplementation(async (r) => ({ id: 1, ...r }))
})

describe('createLink', () => {
  it('resolves the bound passport and builds the short_url', async () => {
    const { passports } = setup()
    const out = await service.createLink({ url: 'https://clinic.com/whitening', passport_id: 'P1', data: { name: 'Jane' } })
    expect(passports.resolve).toHaveBeenCalledWith('P1')
    expect(out).toMatchObject({ code: 'CODE1234', short_url: 'https://go.clinic.com/CODE1234' })
    expect(store.insertLink).toHaveBeenCalledWith(expect.objectContaining({ code: 'CODE1234', url: 'https://clinic.com/whitening', passport_id: 'P1' }))
  })

  it('rejects a non-http url (400)', async () => {
    setup()
    await expect(service.createLink({ url: 'ftp://x/y' })).rejects.toMatchObject({ status: 400 })
  })
})

describe('resolveRedirect', () => {
  const bindable = { code: 'c', url: 'https://clinic.com/whitening', passport_id: 'P1', identify: null, identity_consumed_at: null, identity_expires_at: null, expires_at: null, click_count: 0, max_clicks: null }

  it('mints a claim token and hands it off in the FRAGMENT for a plain destination', async () => {
    setup()
    store.getLink.mockResolvedValue(bindable)
    const r = await service.resolveRedirect('c', { ip: '1.2.3.4', user_agent: 'UA' })
    expect(store.insertClick).toHaveBeenCalledWith(expect.objectContaining({ code: 'c', claim_token: 'TOKEN-XYZ' }))
    expect(r.location).toBe('https://clinic.com/whitening#wb=TOKEN-XYZ')
  })

  it('falls back to a QUERY param when the destination already has a fragment', async () => {
    setup()
    store.getLink.mockResolvedValue({ ...bindable, url: 'https://clinic.com/app#/whitening' })
    const r = await service.resolveRedirect('c', {})
    expect(r.location).toBe('https://clinic.com/app?wb=TOKEN-XYZ#/whitening')
  })

  it('plain-redirects a campaign link (no identity) — no token', async () => {
    setup()
    store.getLink.mockResolvedValue({ ...bindable, passport_id: null, identify: null })
    const r = await service.resolveRedirect('c', {})
    expect(store.insertClick).not.toHaveBeenCalled()
    expect(r.location).toBe('https://clinic.com/whitening')
  })

  it('plain-redirects once the identity is consumed (single-use)', async () => {
    setup()
    store.getLink.mockResolvedValue({ ...bindable, identity_consumed_at: new Date() })
    const r = await service.resolveRedirect('c', {})
    expect(store.insertClick).not.toHaveBeenCalled()
    expect(r.location).toBe('https://clinic.com/whitening')
  })

  it('404s an unknown or expired link', async () => {
    setup()
    expect(await service.resolveRedirect('nope', {})).toBeNull()
    store.getLink.mockResolvedValue({ ...bindable, expires_at: new Date(Date.now() - 1000) })
    expect(await service.resolveRedirect('c', {})).toBeNull()
  })
})

describe('claim', () => {
  const validClick = () => ({ code: 'c', claim_token: 'T', claimed_at: null, expires_at: new Date(Date.now() + 60_000) })

  it('hard-binds: merges the anonymous visitor into the linked customer', async () => {
    const { passports, awareness } = setup()
    store.getClick.mockResolvedValue(validClick())
    store.getLink.mockResolvedValue({ code: 'c', url: 'https://clinic.com/x', passport_id: 'P_known', identify: null, data: { name: 'Jane' } })
    const r = await service.claim('T', 'P_anon')
    expect(store.claimToken).toHaveBeenCalledWith('T', expect.any(Date))
    expect(passports.merge).toHaveBeenCalledWith('P_known', 'P_anon')
    expect(store.consumeIdentity).toHaveBeenCalled()
    expect(awareness.record).toHaveBeenCalled()
    expect(r).toMatchObject({ bound: true, passport_id: 'P_known', data: { name: 'Jane' } })
  })

  it('first-touch: adopts the customer with no merge', async () => {
    const { passports } = setup()
    store.getClick.mockResolvedValue(validClick())
    store.getLink.mockResolvedValue({ code: 'c', url: 'x', passport_id: 'P_known', data: {} })
    const r = await service.claim('T', null)
    expect(passports.merge).not.toHaveBeenCalled()
    expect(r.passport_id).toBe('P_known')
  })

  it('is single-use — a lost race returns bound:false without merging', async () => {
    const { passports } = setup()
    store.getClick.mockResolvedValue(validClick())
    store.claimToken.mockResolvedValue(0)   // someone else won the ticket
    const r = await service.claim('T', 'P_anon')
    expect(r).toEqual({ bound: false })
    expect(passports.merge).not.toHaveBeenCalled()
  })

  it('returns bound:false for an unknown or expired token', async () => {
    setup()
    store.getClick.mockResolvedValue(null)
    expect(await service.claim('nope', null)).toEqual({ bound: false })
    store.getClick.mockResolvedValue({ ...validClick(), expires_at: new Date(Date.now() - 1000) })
    expect(await service.claim('old', null)).toEqual({ bound: false })
  })
})
