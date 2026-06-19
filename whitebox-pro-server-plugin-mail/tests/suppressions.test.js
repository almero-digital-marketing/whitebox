import { describe, it, expect, vi } from 'vitest'
import * as suppressions from '../src/suppressions.js'

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
      insert: (data) => {
        const insertChain = {
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
        }
        return insertChain
      },
    }
    return chain
  }
}

// Re-init the module singleton with a fresh db per test, return the namespace
// so existing `s.add()` / `s.check()` call sites are unchanged.
function makeSuppressions() {
  suppressions.init({ db: makeDb(), logger: { error: vi.fn() } })
  return suppressions
}

function makeRes() {
  const res = { _status: 200, _body: null, _ended: false }
  res.status = (s) => { res._status = s; return res }
  res.json = (b) => { res._body = b; return res }
  res.end = () => { res._ended = true; return res }
  return res
}

describe('suppressions data layer', () => {
  it('add normalizes email and returns row', async () => {
    const s = makeSuppressions()
    const row = await s.add({ email: 'User@Example.com ', reason: 'manual' })
    expect(row.email).toBe('user@example.com')
  })

  it('check returns null for missing email', async () => {
    const s = makeSuppressions()
    const row = await s.check('nobody@x.com')
    expect(row).toBeNull()
  })

  it('check finds existing suppression case-insensitive', async () => {
    const s = makeSuppressions()
    await s.add({ email: 'a@b.com', reason: 'unsubscribed' })
    const row = await s.check('A@B.COM')
    expect(row?.reason).toBe('unsubscribed')
  })

  it('add merges on conflict (upsert)', async () => {
    const s = makeSuppressions()
    const first = await s.add({ email: 'a@b.com', reason: 'unsubscribed' })
    const second = await s.add({ email: 'a@b.com', reason: 'complained' })
    expect(first.id).toBe(second.id)
    expect(second.reason).toBe('complained')
  })

  it('remove deletes by email and returns count', async () => {
    const s = makeSuppressions()
    await s.add({ email: 'a@b.com', reason: 'manual' })
    const n = await s.remove('A@B.COM')
    expect(n).toBe(1)
    expect(await s.check('a@b.com')).toBeNull()
  })

  it('coerces invalid reason to manual', async () => {
    const s = makeSuppressions()
    const row = await s.add({ email: 'a@b.com', reason: 'bogus' })
    expect(row.reason).toBe('manual')
  })
})

describe('suppressions HTTP handlers', () => {
  it('create returns 400 on invalid email', async () => {
    const s = makeSuppressions()
    const res = makeRes()
    await s.create({ body: { email: 'not-an-email' } }, res)
    expect(res._status).toBe(400)
  })

  it('create returns 201 with row on success', async () => {
    const s = makeSuppressions()
    const res = makeRes()
    await s.create({ body: { email: 'a@b.com', reason: 'manual' } }, res)
    expect(res._status).toBe(201)
    expect(res._body?.email).toBe('a@b.com')
  })

  it('show returns 404 when not found', async () => {
    const s = makeSuppressions()
    const res = makeRes()
    await s.show({ params: { email: 'nobody@x.com' } }, res)
    expect(res._status).toBe(404)
  })

  it('show returns row when found', async () => {
    const s = makeSuppressions()
    await s.add({ email: 'a@b.com', reason: 'manual' })
    const res = makeRes()
    await s.show({ params: { email: 'a@b.com' } }, res)
    expect(res._body?.email).toBe('a@b.com')
  })

  it('destroy returns 204 when deleted', async () => {
    const s = makeSuppressions()
    await s.add({ email: 'a@b.com', reason: 'manual' })
    const res = makeRes()
    await s.destroy({ params: { email: 'a@b.com' } }, res)
    expect(res._status).toBe(204)
  })

  it('destroy returns 404 when not present', async () => {
    const s = makeSuppressions()
    const res = makeRes()
    await s.destroy({ params: { email: 'nobody@x.com' } }, res)
    expect(res._status).toBe(404)
  })
})
