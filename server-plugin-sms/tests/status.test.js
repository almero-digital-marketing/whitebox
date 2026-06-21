import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/outbox.js', () => ({ track: vi.fn(async () => ({ id: 1, status: 'delivered', passport_id: 'p1' })) }))
vi.mock('../src/invalid.js', () => ({ add: vi.fn(async () => ({ id: 1 })) }))

import * as status from '../src/status.js'
import * as outbox from '../src/outbox.js'
import * as invalid from '../src/invalid.js'

// Fake provider mimicking a DLR parse (e.g. Mobica): query → canonical event.
const provider = {
  name: 'mobica',
  verifySignature: () => true,
  parseStatus: (req) => ({
    messageId: req.query.id,
    status: req.query.status,
    recipient: req.query.phone,
    blacklisted: req.query.bl === '1',
    errorMessage: req.query.err || null,
  }),
}

function setup({ prov = provider } = {}) {
  const notify = vi.fn(async () => {})
  status.init({ awareness: { record: vi.fn() }, notify, logger: { error: vi.fn() }, router: { byName: () => prov } })
  return { notify }
}

function req(query) { return { params: { provider: 'mobica' }, query, get: () => null } }
function res() { const r = { _s: 200 }; r.status = s => { r._s = s; return r }; r.end = () => r; r.send = () => r; return r }

beforeEach(() => { outbox.track.mockClear(); invalid.add.mockClear() })

describe('status.handle', () => {
  it('advances the outbox status and notifies', async () => {
    const { notify } = setup()
    await status.handle(req({ id: 'abc123', status: 'delivered', phone: '+359888123456' }), res())
    expect(outbox.track).toHaveBeenCalledWith('abc123', 'delivered')
    expect(notify).toHaveBeenCalledWith('sms.delivered', expect.objectContaining({ type: 'sms.delivered' }))
  })

  it('adds a blacklisted recipient to the invalid list', async () => {
    setup()
    await status.handle(req({ id: 'abc', status: 'failed', phone: '+359888123456', bl: '1' }), res())
    expect(invalid.add).toHaveBeenCalledWith(expect.objectContaining({ phone: '+359888123456', reason: 'rejected', source: 'mobica' }))
  })

  it('adds an undelivered recipient to the invalid list', async () => {
    setup()
    await status.handle(req({ id: 'abc', status: 'undelivered', phone: '+359888123456' }), res())
    expect(invalid.add).toHaveBeenCalledWith(expect.objectContaining({ reason: 'undeliverable' }))
  })

  it('blocklists the row recipient (row.to), not the raw DLR phone, on a matched failure', async () => {
    outbox.track.mockResolvedValueOnce({ id: 2, status: 'failed', to: '+359111222333' })
    setup()
    await status.handle(req({ id: 'abc', status: 'failed', phone: '359888123456' }), res())
    expect(invalid.add).toHaveBeenCalledWith(expect.objectContaining({ phone: '+359111222333' }))
  })

  it('does NOT blocklist a fanned-out report that matches no local row', async () => {
    outbox.track.mockResolvedValueOnce(null)   // id minted by another instance
    const { notify } = setup()
    await status.handle(req({ id: 'other-instance-id', status: 'failed', phone: '+359888999000', bl: '1' }), res())
    expect(invalid.add).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('401s on a bad signature, 501 without parseStatus', async () => {
    setup({ prov: { ...provider, verifySignature: () => false } })
    const r1 = res(); await status.handle(req({ id: 'x', status: 'delivered' }), r1); expect(r1._s).toBe(401)
    setup({ prov: { name: 'x', verifySignature: () => true } })
    const r2 = res(); await status.handle(req({ id: 'x', status: 'delivered' }), r2); expect(r2._s).toBe(501)
  })
})
