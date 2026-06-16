import { describe, it, expect, vi } from 'vitest'
import * as tracking from '../src/tracking.js'
import * as suppressions from '../src/suppressions.js'
import * as invalid from '../src/invalid.js'
import * as signature from '../src/signature.js'
import * as outbox from '../src/outbox.js'

// tracking imports the suppression/invalid/signature/outbox singletons
// directly; mock them so the calls stay assertable and controllable.
vi.mock('../src/suppressions.js', () => ({ init: vi.fn(), add: vi.fn(async () => ({ id: 1 })) }))
vi.mock('../src/invalid.js', () => ({ init: vi.fn(), add: vi.fn(async () => ({ id: 1 })) }))
vi.mock('../src/signature.js', () => ({ init: vi.fn(), verify: vi.fn(() => true) }))
vi.mock('../src/outbox.js', () => ({ init: vi.fn(), track: vi.fn(async () => ({ id: 1, status: 'delivered' })) }))

// Re-init the tracking singleton with fresh deps per test, configure the mocked
// signature/outbox behavior, and return the namespace so existing call sites
// (tracking.handle, signature.verify, outbox.track) stay unchanged.
function makeTracking({ trackResult = { id: 1, status: 'delivered' }, verifyResult = true } = {}) {
  suppressions.add.mockClear()
  invalid.add.mockClear()
  signature.verify.mockReset().mockImplementation(() => verifyResult)
  outbox.track.mockReset().mockImplementation(async () => trackResult)
  const notify = vi.fn(async () => {})
  const awareness = { record: vi.fn(async () => ({ id: 1 })) }
  const logger = { error: vi.fn(), warn: vi.fn() }
  tracking.init({ notify, awareness, logger })
  return { tracking, signature, outbox, suppressions, invalid, notify, awareness, logger }
}

function makeReq(event, mailgunId, sigValid = true, extra = {}) {
  return {
    body: {
      signature: sigValid ? { token: 't', timestamp: '1', signature: 's' } : null,
      'event-data': {
        event,
        message: { headers: { 'message-id': mailgunId } },
        ...extra,
      },
    },
  }
}

function makeRes() {
  const res = { _status: 200, _ended: false }
  res.status = (s) => { res._status = s; return res }
  res.end = () => { res._ended = true; return res }
  return res
}

describe('tracking.handle signature', () => {
  it('returns 401 when signature invalid', async () => {
    const { tracking } = makeTracking({ verifyResult: false })
    const res = makeRes()
    await tracking.handle(makeReq('delivered', 'msg1', false), res)
    expect(res._status).toBe(401)
  })

  it('passes context label to verify', async () => {
    const { tracking, signature } = makeTracking()
    const res = makeRes()
    await tracking.handle(makeReq('delivered', 'msg1'), res)
    expect(signature.verify).toHaveBeenCalledWith(expect.anything(), 'Tracking')
  })
})

describe('tracking.handle event mapping', () => {
  it.each([
    ['delivered', 'delivered'],
    ['opened', 'opened'],
    ['clicked', 'engaged'],
    ['failed', 'bounced'],
    ['complained', 'complained'],
  ])('maps mailgun event %s to status %s', async (mgEvent, status) => {
    const { tracking, outbox } = makeTracking()
    const res = makeRes()
    await tracking.handle(makeReq(mgEvent, 'msg1'), res)
    expect(outbox.track).toHaveBeenCalledWith('msg1', status)
    expect(res._status).toBe(200)
  })

  it('ignores unknown event types', async () => {
    const { tracking, outbox, notify } = makeTracking()
    const res = makeRes()
    await tracking.handle(makeReq('bogus', 'msg1'), res)
    expect(outbox.track).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(res._status).toBe(200)
  })

  it('skips notify when track returns null', async () => {
    const { tracking, notify } = makeTracking({ trackResult: null })
    const res = makeRes()
    await tracking.handle(makeReq('delivered', 'msg1'), res)
    expect(notify).not.toHaveBeenCalled()
  })

  it('notifies with correct event type when track succeeds', async () => {
    const row = { id: 1, status: 'delivered' }
    const { tracking, notify } = makeTracking({ trackResult: row })
    const res = makeRes()
    await tracking.handle(makeReq('delivered', 'msg1'), res)
    expect(notify).toHaveBeenCalledWith('mail.delivered', { type: 'mail.delivered', data: row })
  })
})

describe('tracking.handle missing data', () => {
  it('returns 200 and skips track when mailgunId missing', async () => {
    const { tracking, outbox } = makeTracking()
    const res = makeRes()
    const req = {
      body: {
        signature: { token: 't', timestamp: '1', signature: 's' },
        'event-data': { event: 'delivered', message: { headers: {} } },
      },
    }
    await tracking.handle(req, res)
    expect(outbox.track).not.toHaveBeenCalled()
    expect(res._status).toBe(200)
  })

  it('handles track() throwing without crashing', async () => {
    const { tracking, notify, logger } = makeTracking()
    outbox.track.mockReset().mockImplementation(async () => { throw new Error('db error') })
    signature.verify.mockReset().mockImplementation(() => true)
    const res = makeRes()
    await tracking.handle(makeReq('delivered', 'msg1'), res)
    expect(notify).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalled()
    expect(res._status).toBe(200)
  })
})

describe('tracking.handle suppressions', () => {
  it('adds suppression on unsubscribed event', async () => {
    const { tracking, suppressions } = makeTracking()
    await tracking.handle(makeReq('unsubscribed', 'msg1', true, { recipient: 'u@a.com' }), makeRes())
    expect(suppressions.add).toHaveBeenCalledWith({ email: 'u@a.com', reason: 'unsubscribed', source: 'mailgun' })
  })

  it('adds suppression on complained event', async () => {
    const { tracking, suppressions } = makeTracking()
    await tracking.handle(makeReq('complained', 'msg1', true, { recipient: 'u@a.com' }), makeRes())
    expect(suppressions.add).toHaveBeenCalledWith({ email: 'u@a.com', reason: 'complained', source: 'mailgun' })
  })

  it('does not put bounces in suppressions list', async () => {
    const { tracking, suppressions } = makeTracking()
    await tracking.handle(makeReq('failed', 'msg1', true, { recipient: 'u@a.com', severity: 'permanent' }), makeRes())
    expect(suppressions.add).not.toHaveBeenCalled()
  })

  it('does not suppress on delivered/opened/clicked', async () => {
    const { tracking, suppressions } = makeTracking()
    await tracking.handle(makeReq('delivered', 'msg1', true, { recipient: 'u@a.com' }), makeRes())
    await tracking.handle(makeReq('opened', 'msg1', true, { recipient: 'u@a.com' }), makeRes())
    await tracking.handle(makeReq('clicked', 'msg1', true, { recipient: 'u@a.com' }), makeRes())
    expect(suppressions.add).not.toHaveBeenCalled()
  })
})

describe('tracking.handle invalid list', () => {
  it('adds to invalid on failed event with permanent severity', async () => {
    const { tracking, invalid } = makeTracking()
    await tracking.handle(makeReq('failed', 'msg1', true, { recipient: 'u@a.com', severity: 'permanent' }), makeRes())
    expect(invalid.add).toHaveBeenCalledWith(expect.objectContaining({
      email: 'u@a.com',
      reason: 'bounced',
      source: 'mailgun',
    }))
  })

  it('does not add to invalid on temporary severity', async () => {
    const { tracking, invalid } = makeTracking()
    await tracking.handle(makeReq('failed', 'msg1', true, { recipient: 'u@a.com', severity: 'temporary' }), makeRes())
    expect(invalid.add).not.toHaveBeenCalled()
  })

  it('does not add to invalid on unsubscribed/complained', async () => {
    const { tracking, invalid } = makeTracking()
    await tracking.handle(makeReq('unsubscribed', 'msg1', true, { recipient: 'u@a.com' }), makeRes())
    await tracking.handle(makeReq('complained', 'msg1', true, { recipient: 'u@a.com' }), makeRes())
    expect(invalid.add).not.toHaveBeenCalled()
  })
})

describe('tracking.handle awareness recording (user-story interleaving)', () => {
  it('records an awareness expression when a tracked open arrives', async () => {
    const row = {
      id: 42, status: 'opened', mailgun_id: 'mg-1',
      passport_id: 'p-1', session_id: 7,
      subject: 'Spring promo', to: 'alice@x',
    }
    const { tracking, awareness } = makeTracking({ trackResult: row })
    const res = makeRes()
    await tracking.handle(makeReq('opened', 'mg-1'), res)

    expect(awareness.record).toHaveBeenCalledOnce()
    const call = awareness.record.mock.calls[0][0]
    expect(call).toMatchObject({
      passport_id: 'p-1',
      session_id:  7,
      channel:     'mail',
      direction:   'expression',
      source:      'opened',
      content_id:  'mail:42:opened',
    })
    expect(call.text).toContain('Opened: Spring promo')
    expect(call.meta).toMatchObject({ outbox_id: 42, mailgun_id: 'mg-1', to: 'alice@x', status: 'opened' })
  })

  it('records when a clicked event lands (status maps to engaged)', async () => {
    const row = { id: 42, status: 'engaged', mailgun_id: 'mg-1', passport_id: 'p-1', subject: 'X', to: 'a@b' }
    const { tracking, awareness } = makeTracking({ trackResult: row })
    await tracking.handle(makeReq('clicked', 'mg-1'), makeRes())
    const call = awareness.record.mock.calls[0][0]
    expect(call.source).toBe('engaged')
    expect(call.content_id).toBe('mail:42:engaged')
    expect(call.text).toContain('Clicked in: X')
  })

  it('does NOT record awareness for delivered / bounced / complained', async () => {
    for (const event of ['delivered', 'failed', 'complained']) {
      const row = { id: 42, status: 'whatever', mailgun_id: 'mg-1', passport_id: 'p-1', subject: 'X' }
      const { tracking, awareness } = makeTracking({ trackResult: row })
      await tracking.handle(makeReq(event, 'mg-1', true, { recipient: 'a@b' }), makeRes())
      expect(awareness.record, `event ${event} should not record`).not.toHaveBeenCalled()
    }
  })

  it('skips awareness when outbox.track returned null (e.g. rank not advanced)', async () => {
    const { tracking, awareness } = makeTracking({ trackResult: null })
    await tracking.handle(makeReq('opened', 'mg-1'), makeRes())
    expect(awareness.record).not.toHaveBeenCalled()
  })

  it('skips awareness when the outbox row has no passport_id', async () => {
    // Outbound sent to a stranger who has never visited the site etc.
    const row = { id: 42, status: 'opened', mailgun_id: 'mg-1', passport_id: null, subject: 'X' }
    const { tracking, awareness } = makeTracking({ trackResult: row })
    await tracking.handle(makeReq('opened', 'mg-1'), makeRes())
    expect(awareness.record).not.toHaveBeenCalled()
  })

  it('swallows awareness errors and still returns 200', async () => {
    const row = { id: 42, status: 'opened', mailgun_id: 'mg-1', passport_id: 'p-1', subject: 'X' }
    const awareness = { record: vi.fn(async () => { throw new Error('vector store down') }) }
    signature.verify.mockReset().mockImplementation(() => true)
    outbox.track.mockReset().mockImplementation(async () => row)
    const notify = vi.fn(async () => {})
    const logger = { error: vi.fn(), warn: vi.fn() }
    tracking.init({ notify, awareness, logger })
    const res = makeRes()
    await tracking.handle(makeReq('opened', 'mg-1'), res)
    expect(res._status).toBe(200)
    expect(logger.warn).toHaveBeenCalled()
  })

  it('works without an awareness binding (optional dependency)', async () => {
    // Mail plugin should still function if awareness isn't wired in.
    const row = { id: 42, status: 'opened', mailgun_id: 'mg-1', passport_id: 'p-1', subject: 'X' }
    signature.verify.mockReset().mockImplementation(() => true)
    outbox.track.mockReset().mockImplementation(async () => row)
    const notify = vi.fn(async () => {})
    const logger = { error: vi.fn(), warn: vi.fn() }
    tracking.init({ notify, /* awareness omitted */ logger })
    const res = makeRes()
    await expect(tracking.handle(makeReq('opened', 'mg-1'), res)).resolves.not.toThrow()
    expect(res._status).toBe(200)
  })
})
