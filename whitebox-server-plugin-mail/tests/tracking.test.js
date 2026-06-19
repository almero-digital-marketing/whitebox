import { describe, it, expect, vi } from 'vitest'
import * as tracking from '../src/tracking.js'
import * as suppressions from '../src/suppressions.js'
import * as invalid from '../src/invalid.js'
import * as outbox from '../src/outbox.js'

// tracking imports the suppression/invalid/outbox singletons directly; mock
// them so the calls stay assertable. Webhook auth + payload parsing now come
// from the injected provider — the provider hands tracking a canonical event
// ({ messageId, event, recipient, severity, errorMessage }); tracking maps that
// onto outbox status + suppression/invalid side effects.
vi.mock('../src/suppressions.js', () => ({ init: vi.fn(), add: vi.fn(async () => ({ id: 1 })) }))
vi.mock('../src/invalid.js', () => ({ init: vi.fn(), add: vi.fn(async () => ({ id: 1 })) }))
vi.mock('../src/outbox.js', () => ({ init: vi.fn(), track: vi.fn(async () => ({ id: 1, status: 'delivered' })) }))

// Re-init the tracking singleton with a fresh fake provider per test. `parsed`
// is what provider.parseTracking returns; `verifyResult` what verifySignature
// returns. Returns the namespace + provider so call sites stay assertable.
function makeTracking({ parsed = {}, verifyResult = true, trackResult = { id: 1, status: 'delivered' } } = {}) {
  suppressions.add.mockClear()
  invalid.add.mockClear()
  outbox.track.mockReset().mockImplementation(async () => trackResult)
  const provider = {
    name: 'mailgun',
    verifySignature: vi.fn(() => verifyResult),
    parseTracking: vi.fn(() => parsed),
  }
  const notify = vi.fn(async () => {})
  const awareness = { record: vi.fn(async () => ({ id: 1 })) }
  const logger = { error: vi.fn(), warn: vi.fn() }
  tracking.init({ notify, awareness, logger, provider })
  return { tracking, provider, outbox, suppressions, invalid, notify, awareness, logger }
}

// Provider is mocked, so the raw request body is irrelevant.
const req = () => ({ body: {} })

function makeRes() {
  const res = { _status: 200, _ended: false }
  res.status = (s) => { res._status = s; return res }
  res.end = () => { res._ended = true; return res }
  return res
}

describe('tracking.handle signature', () => {
  it('returns 401 when the provider rejects the signature', async () => {
    const { tracking } = makeTracking({ verifyResult: false })
    const res = makeRes()
    await tracking.handle(req(), res)
    expect(res._status).toBe(401)
  })

  it('passes the tracking context to verifySignature', async () => {
    const { tracking, provider } = makeTracking({ parsed: { event: 'delivered', messageId: 'msg1' } })
    await tracking.handle(req(), makeRes())
    expect(provider.verifySignature).toHaveBeenCalledWith(expect.anything(), 'tracking')
  })
})

describe('tracking.handle event mapping', () => {
  it.each([
    ['delivered', 'delivered'],
    ['opened', 'opened'],
    ['clicked', 'engaged'],
    ['bounced', 'bounced'],
    ['complained', 'complained'],
  ])('maps canonical event %s to status %s', async (event, status) => {
    const { tracking, outbox } = makeTracking({ parsed: { event, messageId: 'msg1' } })
    const res = makeRes()
    await tracking.handle(req(), res)
    expect(outbox.track).toHaveBeenCalledWith('msg1', status, { recipient: undefined })
    expect(res._status).toBe(200)
  })

  it('ignores events outside the status map', async () => {
    const { tracking, outbox, notify } = makeTracking({ parsed: { event: 'unsubscribed', messageId: 'msg1', recipient: 'u@a.com' } })
    const res = makeRes()
    await tracking.handle(req(), res)
    expect(outbox.track).not.toHaveBeenCalled()
    expect(res._status).toBe(200)
  })

  it('skips notify when track returns null', async () => {
    const { tracking, notify } = makeTracking({ parsed: { event: 'delivered', messageId: 'msg1' }, trackResult: null })
    await tracking.handle(req(), makeRes())
    expect(notify).not.toHaveBeenCalled()
  })

  it('notifies with the correct event type when track succeeds', async () => {
    const row = { id: 1, status: 'delivered' }
    const { tracking, notify } = makeTracking({ parsed: { event: 'delivered', messageId: 'msg1' }, trackResult: row })
    await tracking.handle(req(), makeRes())
    expect(notify).toHaveBeenCalledWith('mail.delivered', { type: 'mail.delivered', data: row })
  })
})

describe('tracking.handle missing data', () => {
  it('returns 200 and skips track when messageId is missing', async () => {
    const { tracking, outbox } = makeTracking({ parsed: { event: 'delivered', messageId: null } })
    const res = makeRes()
    await tracking.handle(req(), res)
    expect(outbox.track).not.toHaveBeenCalled()
    expect(res._status).toBe(200)
  })

  it('handles track() throwing without crashing', async () => {
    const { tracking, notify, logger, outbox } = makeTracking({ parsed: { event: 'delivered', messageId: 'msg1' } })
    outbox.track.mockReset().mockImplementation(async () => { throw new Error('db error') })
    const res = makeRes()
    await tracking.handle(req(), res)
    expect(notify).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalled()
    expect(res._status).toBe(200)
  })
})

describe('tracking.handle suppressions', () => {
  it('adds a suppression on unsubscribed (sourced to the provider)', async () => {
    const { tracking, suppressions } = makeTracking({ parsed: { event: 'unsubscribed', messageId: 'msg1', recipient: 'u@a.com' } })
    await tracking.handle(req(), makeRes())
    expect(suppressions.add).toHaveBeenCalledWith({ email: 'u@a.com', reason: 'unsubscribed', source: 'mailgun' })
  })

  it('adds a suppression on complained', async () => {
    const { tracking, suppressions } = makeTracking({ parsed: { event: 'complained', messageId: 'msg1', recipient: 'u@a.com' } })
    await tracking.handle(req(), makeRes())
    expect(suppressions.add).toHaveBeenCalledWith({ email: 'u@a.com', reason: 'complained', source: 'mailgun' })
  })

  it('does not put bounces in the suppression list', async () => {
    const { tracking, suppressions } = makeTracking({ parsed: { event: 'bounced', messageId: 'msg1', recipient: 'u@a.com', severity: 'permanent' } })
    await tracking.handle(req(), makeRes())
    expect(suppressions.add).not.toHaveBeenCalled()
  })

  it('does not suppress on delivered/opened/clicked', async () => {
    for (const event of ['delivered', 'opened', 'clicked']) {
      const { tracking, suppressions } = makeTracking({ parsed: { event, messageId: 'msg1', recipient: 'u@a.com' } })
      await tracking.handle(req(), makeRes())
      expect(suppressions.add).not.toHaveBeenCalled()
    }
  })
})

describe('tracking.handle invalid list', () => {
  it('adds to invalid on a permanent bounce', async () => {
    const { tracking, invalid } = makeTracking({ parsed: { event: 'bounced', messageId: 'msg1', recipient: 'u@a.com', severity: 'permanent' } })
    await tracking.handle(req(), makeRes())
    expect(invalid.add).toHaveBeenCalledWith(expect.objectContaining({
      email: 'u@a.com',
      reason: 'bounced',
      source: 'mailgun',
    }))
  })

  it('does not add to invalid on a temporary bounce', async () => {
    const { tracking, invalid } = makeTracking({ parsed: { event: 'bounced', messageId: 'msg1', recipient: 'u@a.com', severity: 'temporary' } })
    await tracking.handle(req(), makeRes())
    expect(invalid.add).not.toHaveBeenCalled()
  })

  it('does not add to invalid on unsubscribed/complained', async () => {
    for (const event of ['unsubscribed', 'complained']) {
      const { tracking, invalid } = makeTracking({ parsed: { event, messageId: 'msg1', recipient: 'u@a.com' } })
      await tracking.handle(req(), makeRes())
      expect(invalid.add).not.toHaveBeenCalled()
    }
  })
})

describe('tracking.handle awareness recording (user-story interleaving)', () => {
  it('records an awareness expression when a tracked open arrives', async () => {
    const row = {
      id: 42, status: 'opened', provider_message_id: 'mg-1',
      passport_id: 'p-1', session_id: 7,
      subject: 'Spring promo', to: 'alice@x',
    }
    const { tracking, awareness } = makeTracking({ parsed: { event: 'opened', messageId: 'mg-1' }, trackResult: row })
    await tracking.handle(req(), makeRes())

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
    expect(call.meta).toMatchObject({ outbox_id: 42, provider_message_id: 'mg-1', to: 'alice@x', status: 'opened' })
  })

  it('records when a clicked event lands (status maps to engaged)', async () => {
    const row = { id: 42, status: 'engaged', provider_message_id: 'mg-1', passport_id: 'p-1', subject: 'X', to: 'a@b' }
    const { tracking, awareness } = makeTracking({ parsed: { event: 'clicked', messageId: 'mg-1' }, trackResult: row })
    await tracking.handle(req(), makeRes())
    const call = awareness.record.mock.calls[0][0]
    expect(call.source).toBe('engaged')
    expect(call.content_id).toBe('mail:42:engaged')
    expect(call.text).toContain('Clicked in: X')
  })

  it('does NOT record awareness for delivered / bounced / complained', async () => {
    for (const event of ['delivered', 'bounced', 'complained']) {
      const row = { id: 42, status: 'whatever', provider_message_id: 'mg-1', passport_id: 'p-1', subject: 'X' }
      const { tracking, awareness } = makeTracking({ parsed: { event, messageId: 'mg-1', recipient: 'a@b' }, trackResult: row })
      await tracking.handle(req(), makeRes())
      expect(awareness.record, `event ${event} should not record`).not.toHaveBeenCalled()
    }
  })

  it('skips awareness when outbox.track returned null', async () => {
    const { tracking, awareness } = makeTracking({ parsed: { event: 'opened', messageId: 'mg-1' }, trackResult: null })
    await tracking.handle(req(), makeRes())
    expect(awareness.record).not.toHaveBeenCalled()
  })

  it('skips awareness when the outbox row has no passport_id', async () => {
    const row = { id: 42, status: 'opened', provider_message_id: 'mg-1', passport_id: null, subject: 'X' }
    const { tracking, awareness } = makeTracking({ parsed: { event: 'opened', messageId: 'mg-1' }, trackResult: row })
    await tracking.handle(req(), makeRes())
    expect(awareness.record).not.toHaveBeenCalled()
  })

  it('swallows awareness errors and still returns 200', async () => {
    const row = { id: 42, status: 'opened', provider_message_id: 'mg-1', passport_id: 'p-1', subject: 'X' }
    const provider = { name: 'mailgun', verifySignature: vi.fn(() => true), parseTracking: vi.fn(() => ({ event: 'opened', messageId: 'mg-1' })) }
    outbox.track.mockReset().mockImplementation(async () => row)
    const notify = vi.fn(async () => {})
    const awareness = { record: vi.fn(async () => { throw new Error('vector store down') }) }
    const logger = { error: vi.fn(), warn: vi.fn() }
    tracking.init({ notify, awareness, logger, provider })
    const res = makeRes()
    await tracking.handle(req(), res)
    expect(res._status).toBe(200)
    expect(logger.warn).toHaveBeenCalled()
  })

  it('works without an awareness binding (optional dependency)', async () => {
    const row = { id: 42, status: 'opened', provider_message_id: 'mg-1', passport_id: 'p-1', subject: 'X' }
    const provider = { name: 'mailgun', verifySignature: vi.fn(() => true), parseTracking: vi.fn(() => ({ event: 'opened', messageId: 'mg-1' })) }
    outbox.track.mockReset().mockImplementation(async () => row)
    const notify = vi.fn(async () => {})
    const logger = { error: vi.fn(), warn: vi.fn() }
    tracking.init({ notify, /* awareness omitted */ logger, provider })
    const res = makeRes()
    await expect(tracking.handle(req(), res)).resolves.not.toThrow()
    expect(res._status).toBe(200)
  })
})
