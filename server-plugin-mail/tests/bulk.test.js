import { describe, it, expect, vi } from 'vitest'
import * as bulk from '../src/bulk.js'
import * as suppressions from '../src/suppressions.js'
import * as invalid from '../src/invalid.js'
import * as outbox from '../src/outbox.js'
import * as attachments from '../src/attachments.js'

// bulk imports the outbox/attachments singletons directly; mock them so the
// per-test mock outbox can drive createMany/cancelBatch/batchStats/outboxQueue
// and the attachment fetcher stays controllable.
vi.mock('../src/outbox.js', () => ({
  init: vi.fn(),
  createMany: vi.fn(),
  cancelBatch: vi.fn(),
  batchStats: vi.fn(),
  outboxQueue: { addBulk: vi.fn(), add: vi.fn(), remove: vi.fn() },
}))
vi.mock('../src/attachments.js', () => ({
  init: vi.fn(),
  saveUrl: vi.fn(async (url) => `/mail/attachments/${url.split('/').pop()}`),
}))

// db that routes checkMany by table → seeded suppressed / invalid emails.
function makeListDb({ suppressedEmails = [], invalidEmails = [] }) {
  const byTable = {
    whitebox_mail_suppressions: suppressedEmails,
    whitebox_mail_invalid: invalidEmails,
  }
  return (table) => {
    const emails = byTable[table] || []
    const chain = {
      whereIn: () => chain,
      where: () => chain,
      select: async () => emails.map(email => ({ email })),
      first: async () => null,
    }
    return chain
  }
}

// Configure the mocked outbox singleton with fresh per-test behavior and return
// the mocked module namespace so `outbox.createMany` etc. stay assertable.
function makeOutbox(overrides = {}) {
  const created = []
  const enqueued = []
  const removed = []
  const defaults = {
    createMany: async (items) => {
      const rows = items.map((item, i) => ({ id: created.length + i + 1, status: 'queued', ...item }))
      created.push(...rows)
      return rows
    },
    cancelBatch: async (batchId) => ({ batch_id: batchId, cancelled: 3 }),
    batchStats: async (batchId) => ({ batch_id: batchId, totals: { queued: 2 } }),
    addBulk: async (jobs) => { enqueued.push(...jobs) },
    add: async () => {},
    remove: async (jobId) => { removed.push(jobId); return 1 },
    ...overrides,
  }

  outbox.createMany.mockReset().mockImplementation(defaults.createMany)
  outbox.cancelBatch.mockReset().mockImplementation(defaults.cancelBatch)
  outbox.batchStats.mockReset().mockImplementation(defaults.batchStats)
  outbox.outboxQueue.addBulk.mockReset().mockImplementation(defaults.addBulk)
  outbox.outboxQueue.add.mockReset().mockImplementation(defaults.add)
  outbox.outboxQueue.remove.mockReset().mockImplementation(defaults.remove)

  outbox._created = created
  outbox._enqueued = enqueued
  outbox._removed = removed
  return outbox
}

function makeBulk({ outbox: outboxOverrides, suppressedEmails = [], invalidEmails = [], notify, provider } = {}) {
  const ob = makeOutbox(outboxOverrides ?? {})
  attachments.saveUrl.mockReset().mockImplementation(async (url) => `/mail/attachments/${url.split('/').pop()}`)
  // Init the suppression/invalid singletons with a db that yields the seeded sets.
  const db = makeListDb({ suppressedEmails, invalidEmails })
  suppressions.init({ db, logger: { error: vi.fn() } })
  invalid.init({ db, logger: { error: vi.fn() } })
  bulk.init({
    notify: notify ?? vi.fn(async () => {}),
    logger: { warn: vi.fn(), error: vi.fn() },
    provider,
  })
  return { bulk, outbox: ob }
}

function makeRes() {
  const res = { _status: 200, _body: null }
  res.status = (s) => { res._status = s; return res }
  res.json = (b) => { res._body = b; return res }
  res.end = () => res
  return res
}

describe('bulk.send', () => {
  it('creates one outbox row per recipient with shared batch_id', async () => {
    const { bulk, outbox } = makeBulk()
    const result = await bulk.send({
      subject: 'Hi',
      text: 'hello',
      recipients: [{ to: 'a@x.com' }, { to: 'b@x.com' }],
    })

    expect(result.accepted).toBe(2)
    expect(outbox.createMany).toHaveBeenCalled()
    const items = outbox.createMany.mock.calls[0][0]
    expect(items).toHaveLength(2)
    expect(items.every(i => i.batchId === result.batch_id)).toBe(true)
  })

  it('dedupes recipients case-insensitively', async () => {
    const { bulk } = makeBulk()
    const result = await bulk.send({
      subject: 'Hi',
      text: 'hi',
      recipients: [{ to: 'a@x.com' }, { to: 'A@X.COM' }, { to: 'b@x.com' }],
    })
    expect(result.accepted).toBe(2)
    expect(result.duplicates).toBe(1)
  })

  it('skips suppressed recipients', async () => {
    const { bulk } = makeBulk({ suppressedEmails: ['a@x.com'] })
    const result = await bulk.send({
      subject: 'Hi',
      text: 'hi',
      recipients: [{ to: 'a@x.com' }, { to: 'b@x.com' }],
    })
    expect(result.accepted).toBe(1)
    expect(result.skipped_suppressed).toBe(1)
  })

  it('skips invalid recipients', async () => {
    const { bulk } = makeBulk({ invalidEmails: ['bad@x.com'] })
    const result = await bulk.send({
      subject: 'Hi',
      text: 'hi',
      recipients: [{ to: 'bad@x.com' }, { to: 'good@x.com' }],
    })
    expect(result.accepted).toBe(1)
    expect(result.skipped_invalid).toBe(1)
  })

  it('preserves per-recipient data', async () => {
    const { bulk, outbox } = makeBulk()
    await bulk.send({
      subject: 'Hi {{name}}',
      template: 'newsletter',
      recipients: [{ to: 'a@x.com', data: { name: 'Alice' } }, { to: 'b@x.com', data: { name: 'Bob' } }],
    })
    const items = outbox.createMany.mock.calls[0][0]
    expect(items[0].data).toEqual({ name: 'Alice' })
    expect(items[1].data).toEqual({ name: 'Bob' })
  })

  it('bulk-enqueues jobs via addBulk with jobId set to row id', async () => {
    const { bulk, outbox } = makeBulk()
    await bulk.send({
      subject: 'Hi',
      text: 'hi',
      recipients: [{ to: 'a@x.com' }, { to: 'b@x.com' }],
    })
    expect(outbox.outboxQueue.addBulk).toHaveBeenCalled()
    const jobs = outbox.outboxQueue.addBulk.mock.calls[0][0]
    expect(jobs).toHaveLength(2)
    expect(jobs[0]).toMatchObject({
      name: 'send',
      data: { id: expect.any(Number) },
      opts: { jobId: expect.any(String) },
    })
  })

  it('chunk-enqueues batch jobs when the provider supports native batch', async () => {
    const provider = { sendBatch: () => {}, maxBatchSize: 2 }
    const { bulk, outbox } = makeBulk({ provider })
    await bulk.send({
      subject: 'Hi',
      text: 'hi',
      recipients: [{ to: 'a@x.com' }, { to: 'b@x.com' }, { to: 'c@x.com' }],
    })
    const jobs = outbox.outboxQueue.addBulk.mock.calls[0][0]
    // 3 recipients at maxBatchSize 2 → two chunk jobs (2 + 1)
    expect(jobs).toHaveLength(2)
    expect(jobs[0]).toMatchObject({ name: 'batch', data: { ids: expect.any(Array) } })
    expect(jobs[0].data.ids).toHaveLength(2)
    expect(jobs[1].data.ids).toHaveLength(1)
    expect(jobs[0].opts.jobId).toMatch(/-c0$/)
    expect(jobs[1].opts.jobId).toMatch(/-c1$/)
  })

  it('falls back to one job per row when the provider has no sendBatch', async () => {
    const { bulk, outbox } = makeBulk({ provider: { /* no sendBatch */ } })
    await bulk.send({ subject: 'Hi', text: 'hi', recipients: [{ to: 'a@x.com' }, { to: 'b@x.com' }] })
    const jobs = outbox.outboxQueue.addBulk.mock.calls[0][0]
    expect(jobs.every(j => j.name === 'send')).toBe(true)
  })

  it('notifies mail.bulk.queued', async () => {
    const notify = vi.fn(async () => {})
    const { bulk } = makeBulk({ notify })
    await bulk.send({
      subject: 'Hi',
      text: 'hi',
      recipients: [{ to: 'a@x.com' }],
    })
    expect(notify).toHaveBeenCalledWith('mail.bulk.queued', expect.objectContaining({
      type: 'mail.bulk.queued',
    }))
  })

  it('resolves URL attachments once for the whole batch', async () => {
    const { bulk, outbox } = makeBulk()
    await bulk.send({
      subject: 'Hi',
      text: 'hi',
      attachment_urls: ['https://example.com/a.pdf'],
      recipients: [{ to: 'a@x.com' }, { to: 'b@x.com' }],
    })
    const items = outbox.createMany.mock.calls[0][0]
    expect(items[0].attachments).toEqual(['/mail/attachments/a.pdf'])
    expect(items[1].attachments).toEqual(['/mail/attachments/a.pdf'])
  })
})

describe('bulk.create (HTTP)', () => {
  it('returns 400 on validation error (no content)', async () => {
    const { bulk } = makeBulk()
    const res = makeRes()
    await bulk.create({ body: { subject: 'x', recipients: [{ to: 'a@x.com' }] } }, res)
    expect(res._status).toBe(400)
  })

  it('returns 400 when no recipients', async () => {
    const { bulk } = makeBulk()
    const res = makeRes()
    await bulk.create({ body: { subject: 'x', text: 'hi', recipients: [] } }, res)
    expect(res._status).toBe(400)
  })

  it('returns 202 with batch info on success', async () => {
    const { bulk } = makeBulk()
    const res = makeRes()
    await bulk.create({ body: {
      subject: 'Hi', text: 'hello',
      recipients: [{ to: 'a@x.com' }, { to: 'b@x.com' }],
    } }, res)
    expect(res._status).toBe(202)
    expect(res._body?.accepted).toBe(2)
    expect(res._body?.batch_id).toBeDefined()
  })
})

describe('bulk.cancel (HTTP)', () => {
  it('cancels queued rows and returns count', async () => {
    const { bulk, outbox } = makeBulk()
    const res = makeRes()
    await bulk.cancel({ params: { batchId: 'some-uuid' } }, res)
    expect(outbox.cancelBatch).toHaveBeenCalledWith('some-uuid')
    expect(res._body?.cancelled).toBe(3)
  })

  it('notifies mail.bulk.cancelled when rows were cancelled', async () => {
    const notify = vi.fn(async () => {})
    const { bulk } = makeBulk({ notify })
    await bulk.cancel({ params: { batchId: 'uuid' } }, makeRes())
    expect(notify).toHaveBeenCalledWith('mail.bulk.cancelled', expect.objectContaining({
      type: 'mail.bulk.cancelled',
    }))
  })

  it('does not notify when zero rows cancelled', async () => {
    const notify = vi.fn(async () => {})
    const { bulk } = makeBulk({
      outbox: { cancelBatch: async (batchId) => ({ batch_id: batchId, cancelled: 0 }) },
      notify,
    })
    await bulk.cancel({ params: { batchId: 'uuid' } }, makeRes())
    expect(notify).not.toHaveBeenCalledWith('mail.bulk.cancelled', expect.anything())
  })
})

describe('bulk.show (HTTP)', () => {
  it('returns batch stats', async () => {
    const { bulk } = makeBulk()
    const res = makeRes()
    await bulk.show({ params: { batchId: 'some-uuid' } }, res)
    expect(res._body?.totals).toEqual({ queued: 2 })
  })

  it('returns 404 when no rows match batch', async () => {
    const { bulk } = makeBulk({
      outbox: { batchStats: async (batchId) => ({ batch_id: batchId, totals: {} }) },
    })
    const res = makeRes()
    await bulk.show({ params: { batchId: 'missing' } }, res)
    expect(res._status).toBe(404)
  })
})
