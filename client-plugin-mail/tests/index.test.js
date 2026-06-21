import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import whitebox from 'whitebox-pro-client'
import mail from '../src/index.js'

function jsonOk(body) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) }
}

describe('mail plugin', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })
  afterEach(() => {
    delete globalThis.fetch
  })

  it('submit() POSTs to /mail/inbox with the body fields', async () => {
    const calls = []
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url, init })
      if (url.endsWith('/sessions/resolve')) return jsonOk({ sessionId: 1, passportId: 'p' })
      return jsonOk({ id: 99, status: 'received' })
    })

    const wb = whitebox({ url: 'https://api.example.com', transport: false, logger: { warn: () => {} } }).use(mail())
    await wb.ready
    const res = await wb.mail.submit({
      from: 'user@example.com',
      subject: 'Question',
      body: 'Hello there',
    })

    expect(res).toEqual({ id: 99, status: 'received' })
    const submitCall = calls.find(c => c.url.endsWith('/mail/inbox'))
    expect(submitCall).toBeDefined()
    expect(submitCall.init.method).toBe('POST')
    const body = JSON.parse(submitCall.init.body)
    expect(body).toMatchObject({
      from: 'user@example.com',
      subject: 'Question',
      body: 'Hello there',
    })
  })

  it('throws when required fields missing', async () => {
    globalThis.fetch = vi.fn(async () => jsonOk({}))
    const wb = whitebox({ url: 'https://api.example.com', transport: false, logger: { warn: () => {} } }).use(mail())
    await wb.ready
    await expect(wb.mail.submit({ subject: 'x' })).rejects.toThrow(/from/)
    await expect(wb.mail.submit({ from: 'a@b.com' })).rejects.toThrow(/subject/)
  })

  it('sends multipart when files are provided', async () => {
    let captured
    globalThis.fetch = vi.fn(async (url, init) => {
      if (url.endsWith('/mail/inbox')) captured = init
      return jsonOk({ id: 1 })
    })
    const wb = whitebox({ url: 'https://api.example.com', transport: false, logger: { warn: () => {} } }).use(mail())
    await wb.ready

    const file = new File(['hello'], 'note.txt', { type: 'text/plain' })
    await wb.mail.submit({
      from: 'a@b.com',
      subject: 's',
      files: [file],
    })

    expect(captured.body).toBeInstanceOf(FormData)
    expect(captured.headers['content-type']).toBeUndefined()  // browser sets multipart boundary
  })

  it('queues calls made before ready', async () => {
    let resolveSession
    const sessionPromise = new Promise(r => { resolveSession = r })
    globalThis.fetch = vi.fn(async (url) => {
      if (url.endsWith('/sessions/resolve')) {
        await sessionPromise
        return jsonOk({ sessionId: 1, passportId: 'p' })
      }
      return jsonOk({ id: 7 })
    })

    const wb = whitebox({ url: 'https://api.example.com', transport: false, logger: { warn: () => {} } }).use(mail())

    // Submit BEFORE ready — should queue, then fire after init completes
    const submitPromise = wb.mail.submit({ from: 'a@b.com', subject: 's', body: 'b' })
    resolveSession()
    const res = await submitPromise
    expect(res).toEqual({ id: 7 })
  })
})
