import { describe, it, expect, vi } from 'vitest'
import * as invalid from '../src/invalid.js'
import { classifyMailerError } from '../src/invalid.js'

function makeDb() {
  const rows = []
  let nextId = 1
  return (table) => {
    let filter = null
    const chain = {
      where: (cond) => { filter = cond; return chain },
      first: async () => rows.find(r => Object.entries(filter).every(([k, v]) => r[k] === v)) || null,
      del: async () => {
        const before = rows.length
        for (let i = rows.length - 1; i >= 0; i--) {
          if (Object.entries(filter).every(([k, v]) => rows[i][k] === v)) rows.splice(i, 1)
        }
        return before - rows.length
      },
      orderBy: () => chain,
      limit: () => chain,
      offset: () => Promise.resolve(rows),
      insert: (data) => ({
        onConflict: () => ({
          merge: (mergeData) => ({
            returning: async () => {
              const existing = rows.find(r => r.email === data.email)
              if (existing) {
                Object.assign(existing, mergeData)
                return [existing]
              }
              const row = { id: nextId++, created_at: new Date(), ...data }
              rows.push(row)
              return [row]
            },
          }),
        }),
      }),
    }
    return chain
  }
}

// Re-init the module singleton with a fresh db per test, return the namespace
// so existing `inv.add()` / `inv.check()` call sites are unchanged.
function makeInvalid() {
  invalid.init({ db: makeDb(), logger: { error: vi.fn() } })
  return invalid
}

describe('classifyMailerError', () => {
  it('marks 4xx status code as permanent', () => {
    expect(classifyMailerError({ statusCode: 400, message: 'whatever' }).permanent).toBe(true)
    expect(classifyMailerError({ status: 451, message: 'x' }).permanent).toBe(true)
    expect(classifyMailerError({ responseCode: 400, message: 'x' }).permanent).toBe(true)
  })

  it('does not mark 5xx as permanent', () => {
    expect(classifyMailerError({ statusCode: 500, message: 'server error' }).permanent).toBe(false)
    expect(classifyMailerError({ statusCode: 503, message: 'timeout' }).permanent).toBe(false)
  })

  it('marks known keywords as permanent without status code', () => {
    expect(classifyMailerError({ message: 'to is invalid' }).permanent).toBe(true)
    expect(classifyMailerError({ message: 'no recipients' }).permanent).toBe(true)
    expect(classifyMailerError({ message: 'address rejected' }).permanent).toBe(true)
    expect(classifyMailerError({ message: 'mailbox not found' }).permanent).toBe(true)
  })

  it('does not mark generic transient errors as permanent', () => {
    expect(classifyMailerError({ message: 'connection reset' }).permanent).toBe(false)
    expect(classifyMailerError({ message: 'timeout' }).permanent).toBe(false)
  })

  it('handles null/undefined safely', () => {
    expect(classifyMailerError(null).permanent).toBe(false)
    expect(classifyMailerError(undefined).permanent).toBe(false)
    expect(classifyMailerError({}).permanent).toBe(false)
  })
})

describe('invalid data layer', () => {
  it('add normalizes email', async () => {
    const inv = makeInvalid()
    const row = await inv.add({ email: 'Bad@X.com', reason: 'rejected' })
    expect(row.email).toBe('bad@x.com')
  })

  it('check finds existing case-insensitive', async () => {
    const inv = makeInvalid()
    await inv.add({ email: 'a@b.com', reason: 'bounced', errorMessage: 'mailbox not found' })
    const row = await inv.check('A@B.COM')
    expect(row?.reason).toBe('bounced')
    expect(row?.error_message).toBe('mailbox not found')
  })

  it('add upserts on conflict', async () => {
    const inv = makeInvalid()
    const first = await inv.add({ email: 'a@b.com', reason: 'rejected' })
    const second = await inv.add({ email: 'a@b.com', reason: 'bounced' })
    expect(first.id).toBe(second.id)
    expect(second.reason).toBe('bounced')
  })

  it('remove deletes', async () => {
    const inv = makeInvalid()
    await inv.add({ email: 'a@b.com', reason: 'rejected' })
    const n = await inv.remove('a@b.com')
    expect(n).toBe(1)
    expect(await inv.check('a@b.com')).toBeNull()
  })

  it('coerces invalid reason', async () => {
    const inv = makeInvalid()
    const row = await inv.add({ email: 'a@b.com', reason: 'bogus' })
    expect(row.reason).toBe('rejected')
  })
})

describe('invalid HTTP handlers', () => {
  function makeRes() {
    const res = { _status: 200, _body: null, _ended: false }
    res.status = (s) => { res._status = s; return res }
    res.json = (b) => { res._body = b; return res }
    res.end = () => { res._ended = true; return res }
    return res
  }

  it('create returns 400 on invalid email', async () => {
    const inv = makeInvalid()
    const res = makeRes()
    await inv.create({ body: { email: 'not-an-email' } }, res)
    expect(res._status).toBe(400)
  })

  it('create returns 201 on success', async () => {
    const inv = makeInvalid()
    const res = makeRes()
    await inv.create({ body: { email: 'a@b.com', reason: 'rejected' } }, res)
    expect(res._status).toBe(201)
    expect(res._body?.email).toBe('a@b.com')
  })

  it('show returns 404 when missing', async () => {
    const inv = makeInvalid()
    const res = makeRes()
    await inv.show({ params: { email: 'x@y.com' } }, res)
    expect(res._status).toBe(404)
  })

  it('destroy returns 204 when deleted', async () => {
    const inv = makeInvalid()
    await inv.add({ email: 'a@b.com', reason: 'rejected' })
    const res = makeRes()
    await inv.destroy({ params: { email: 'a@b.com' } }, res)
    expect(res._status).toBe(204)
  })
})
