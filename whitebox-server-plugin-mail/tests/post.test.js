import { describe, it, expect, vi } from 'vitest'
import * as outbox from '../src/outbox.js'

const DOMAIN = 'mail.example.com'

// outboxMail calls the internal create() closure, which uses db.
// Control what create() returns by shaping the db mock.
function makeDb({ insertResult, throwOnInsert } = {}) {
  return (table) => ({
    where: () => ({ first: async () => null }),
    insert: (data) => {
      if (throwOnInsert) return { returning: async () => { throw new Error('boom') } }
      const row = { id: 1, status: 'queued', sent_at: null, ...insertResult, ...data }
      return { returning: async () => [row] }
    },
  })
}

// Re-init the outbox singleton with fresh deps per test, return the namespace
// so existing `outbox.outboxMail(...)` call sites are unchanged.
function makeOutbox({ db, outboxQueue, notify, sessions } = {}) {
  const queue = outboxQueue ?? { add: vi.fn(async () => {}) }
  outbox.init({
    config: { mail: { outbox: {} } },
    db: db ?? makeDb(),
    q: {
      createQueue: vi.fn(() => queue),
      createWorker: vi.fn(() => ({ on: vi.fn() })),
    },
    templates: null,
    passports: { identify: vi.fn(), link: vi.fn() },
    sessions: sessions ?? { resolve: vi.fn(async () => ({ id: 99, passport_id: 42 })) },
    notify: notify ?? vi.fn(async () => {}),
    logger: { warn: vi.fn(), error: vi.fn() },
  })
  return outbox
}

function makeReq({ body = {}, query = {}, headers = {} } = {}) {
  return {
    body,
    query,
    get: (name) => headers[name.toLowerCase()] ?? null,
    files: [],
  }
}

function makeRes() {
  const res = { _status: 200, _body: null }
  res.status = (s) => { res._status = s; return res }
  res.json = (b) => { res._body = b; return res }
  return res
}

describe('outbox.outboxMail', () => {
  it('creates outbox row and enqueues send job', async () => {
    const outboxQueue = { add: vi.fn(async () => {}) }
    const notify = vi.fn(async () => {})
    const db = makeDb({ insertResult: { id: 7, status: 'queued', sent_at: null } })
    const outbox = makeOutbox({ db, outboxQueue, notify })
    const req = makeReq({ body: { to: `cust@${DOMAIN}`, subject: 'Welcome', html: '<p>Hi</p>' } })
    const res = makeRes()

    await outbox.outboxMail(req, res)

    expect(outboxQueue.add).toHaveBeenCalledWith('send', { id: 7 }, expect.anything())
    expect(notify).toHaveBeenCalledWith('mail.queued', expect.objectContaining({ type: 'mail.queued' }))
    expect(res._body?.id).toBe(7)
  })

  it('does not re-enqueue if already sent (idempotent re-create)', async () => {
    const outboxQueue = { add: vi.fn(async () => {}) }
    const notify = vi.fn(async () => {})
    const db = makeDb({ insertResult: { id: 5, status: 'sent', sent_at: new Date() } })
    const outbox = makeOutbox({ db, outboxQueue, notify })
    const req = makeReq({ body: { to: `cust@${DOMAIN}`, subject: 'Hi', html: '<p>Hi</p>' } })

    await outbox.outboxMail(req, makeRes())

    expect(outboxQueue.add).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalledWith('mail.queued', expect.anything())
  })

  it('reads idempotency-key header and passes to outbox.create', async () => {
    const outboxQueue = { add: vi.fn(async () => {}) }
    // Make db capture the inserted data so we can assert idempotencyKey was passed
    let captured = null
    const db = (table) => ({
      where: () => ({ first: async () => null }),
      insert: (data) => {
        captured = data
        return { returning: async () => [{ id: 3, status: 'queued', sent_at: null, ...data }] }
      },
    })
    const outbox = makeOutbox({ db, outboxQueue })
    const req = makeReq({
      body: { to: `a@${DOMAIN}`, subject: 'x', text: 'hello' },
      headers: { 'idempotency-key': 'my-key-123' },
    })

    await outbox.outboxMail(req, makeRes())

    expect(captured?.idempotency_key).toBe('my-key-123')
    expect(outboxQueue.add).toHaveBeenCalledWith('send', expect.anything(), { jobId: 'my-key-123' })
  })

  it('returns 400 on validation error', async () => {
    const outbox = makeOutbox()
    const res = makeRes()
    // Missing html/text/template
    await outbox.outboxMail(makeReq({ body: { to: `a@${DOMAIN}`, subject: 'x' } }), res)
    expect(res._status).toBe(400)
  })

  it('passes data field through to outbox row for template rendering', async () => {
    let captured = null
    const db = (table) => ({
      where: () => ({ first: async () => null }),
      insert: (rowData) => {
        captured = rowData
        return { returning: async () => [{ id: 9, status: 'queued', sent_at: null, ...rowData }] }
      },
    })
    const outbox = makeOutbox({ db })
    const req = makeReq({
      body: {
        to: `a@${DOMAIN}`,
        subject: 'Hi {{name}}',
        template: 'welcome',
        data: { name: 'Alice', plan: 'Pro' },
      },
    })
    await outbox.outboxMail(req, makeRes())
    expect(captured?.data).toEqual({ name: 'Alice', plan: 'Pro' })
  })

  it('returns 500 on unexpected error', async () => {
    const db = (table) => ({
      where: () => ({ first: async () => null }),
      insert: () => { return { returning: async () => { throw new Error('boom') } } },
    })
    const outbox = makeOutbox({ db })
    const res = makeRes()
    await outbox.outboxMail(makeReq({ body: { to: `a@${DOMAIN}`, subject: 'x', text: 'hello' } }), res)
    expect(res._status).toBe(500)
  })
})
