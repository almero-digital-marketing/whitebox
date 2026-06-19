import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/suppressions.js', () => ({ init: vi.fn(), add: vi.fn(async () => ({ id: 1 })), remove: vi.fn(async () => 1) }))

import * as inbox from '../src/inbox.js'
import * as suppressions from '../src/suppressions.js'

const provider = {
  name: 'twilio',
  verifySignature: () => true,
  parseInbound: (req) => ({ from: req.body.From, to: req.body.To, body: req.body.Body, messageId: req.body.MessageSid }),
}

function setup({ prov = provider } = {}) {
  const inserted = []
  const db = () => ({ insert: (row) => ({ returning: async () => { const r = { id: 1, created_at: new Date(), ...row }; inserted.push(r); return [r] } }) })
  const awareness = { record: vi.fn(async () => {}) }
  const notify = vi.fn(async () => {})
  inbox.init({
    config: { sms: { defaultCountry: 'BG' } },
    db,
    passports: { identify: vi.fn(async () => 'p1'), link: vi.fn(async () => {}) },
    sessions: { resolve: vi.fn(async () => ({ id: 7 })) },
    awareness, notify,
    logger: { warn: vi.fn(), error: vi.fn() },
    router: { byName: () => prov },
  })
  return { inserted, awareness, notify }
}

function req(body) { return { params: { provider: 'twilio' }, body, get: () => null, query: {} } }
function res() { const r = { _s: 200 }; r.status = s => { r._s = s; return r }; r.end = () => r; r.send = () => r; return r }

beforeEach(() => { suppressions.add.mockClear(); suppressions.remove.mockClear() })

describe('inbox.handle', () => {
  it('suppresses on a STOP reply', async () => {
    setup()
    await inbox.handle(req({ From: '+359888123456', To: '+35924000000', Body: 'STOP' }), res())
    expect(suppressions.add).toHaveBeenCalledWith(expect.objectContaining({ phone: '+359888123456', reason: 'unsubscribed', source: 'inbound' }))
  })

  it('un-suppresses on START', async () => {
    setup()
    await inbox.handle(req({ From: '+359888123456', Body: 'START' }), res())
    expect(suppressions.remove).toHaveBeenCalledWith('+359888123456')
  })

  it('stores a normal reply + records awareness, normalizing the sender', async () => {
    const { inserted, awareness, notify } = setup()
    const r = res()
    await inbox.handle(req({ From: '0888123456', To: '+35924000000', Body: 'Yes please' }), r)
    expect(inserted[0]).toMatchObject({ from: '+359888123456', body: 'Yes please', provider: 'twilio', keyword: null })
    expect(awareness.record).toHaveBeenCalledOnce()
    expect(notify).toHaveBeenCalledWith('sms.received', expect.objectContaining({ type: 'sms.received' }))
    expect(r._s).toBe(200)
    expect(suppressions.add).not.toHaveBeenCalled()
  })

  it('401s when the provider rejects the signature', async () => {
    setup({ prov: { ...provider, verifySignature: () => false } })
    const r = res()
    await inbox.handle(req({ From: '+359888123456', Body: 'hi' }), r)
    expect(r._s).toBe(401)
  })

  it('501s when the provider has no parseInbound (send-only)', async () => {
    setup({ prov: { name: 'mobica', verifySignature: () => true } })
    const r = res()
    await inbox.handle(req({ From: '+359888123456', Body: 'hi' }), r)
    expect(r._s).toBe(501)
  })

  it('404s for an unknown provider', async () => {
    setup({ prov: null })
    const r = res()
    await inbox.handle(req({ From: '+359888123456', Body: 'hi' }), r)
    expect(r._s).toBe(404)
  })
})
