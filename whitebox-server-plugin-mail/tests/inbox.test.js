import { describe, it, expect, vi } from 'vitest'
import * as inboxModule from '../src/inbox.js'
import { extractIdentities } from '../src/inbox.js'
import * as attachments from '../src/attachments.js'

// inbox imports the mailer/attachments singletons directly; mock them so
// attachment saving stays assertable and the leaf mailer stub stays inert for
// the inboxMail path under test. Webhook auth + payload parsing now come from
// the injected provider (see makeInbox).
vi.mock('../src/mailer.js', () => ({ init: vi.fn(), send: vi.fn(async () => {}) }))
vi.mock('../src/attachments.js', () => ({
  init: vi.fn(),
  saveBuffer: vi.fn(async (buf, name) => `/mail/attachments/${name}`),
}))

const DOMAIN = 'mail.example.com'
const COMPANY = 'info@mail.example.com'

function makeDb(store = {}) {
  let nextId = 1
  return (table) => {
    if (!store[table]) store[table] = []
    const rows = store[table]
    return {
      where: (cond) => ({
        first: async () => rows.find(r => Object.entries(cond).every(([k, v]) => r[k] === v)) ?? null,
      }),
      insert: (data) => {
        const row = { id: nextId++, ...data }
        rows.push(row)
        return { returning: async () => [row] }
      },
    }
  }
}

// Re-init the inbox singleton with fresh deps per test. Configure the mocked
// attachments singleton, then return a thin wrapper exposing the handlers plus
// the captured forward queue so existing call sites (inbox.inboxMail,
// inbox._forwardQueue) stay unchanged.
function makeInbox({ notify, sessions, passports, attachments: attachmentsOverrides } = {}) {
  const forwardQueue = { add: vi.fn(async () => {}) }

  if (attachmentsOverrides?.saveBuffer) attachments.saveBuffer.mockReset().mockImplementation(attachmentsOverrides.saveBuffer)
  else attachments.saveBuffer.mockReset().mockImplementation(async (buf, name) => `/mail/attachments/${name}`)

  inboxModule.init({
    config: { mail: { company: COMPANY } },
    db: makeDb(),
    q: { createQueue: vi.fn(() => forwardQueue), createWorker: vi.fn(() => {}) },
    passports: passports ?? { identify: vi.fn(async () => 'passport-1'), link: vi.fn(async () => {}) },
    sessions: sessions ?? { resolve: vi.fn(async () => ({ id: 1, passport_id: 'passport-1' })) },
    notify: notify ?? vi.fn(async () => {}),
    logger: { warn: vi.fn(), error: vi.fn() },
    provider: {
      name: 'mailgun',
      ownsAddress: (a) => typeof a === 'string' && a.endsWith(`@${DOMAIN}`),
    },
  })
  return {
    inboxMail: (...args) => inboxModule.inboxMail(...args),
    handle: (...args) => inboxModule.handle(...args),
    _forwardQueue: forwardQueue,
  }
}

function makeReq(body = {}, query = {}, files = []) {
  return { body, query, files }
}

function makeRes() {
  const res = { _status: 200, _body: null }
  res.status = (s) => { res._status = s; return res }
  res.json = (b) => { res._body = b; return res }
  return res
}

describe('inbox.inboxMail', () => {
  it('inserts row, enqueues forward and notifies', async () => {
    const notify = vi.fn(async () => {})
    const inbox = makeInbox({ notify })
    const res = makeRes()

    await inbox.inboxMail(makeReq({ from: 'user@a.com', subject: 'Hi', body: 'Hello' }), res)

    expect(inbox._forwardQueue.add).toHaveBeenCalledWith('forward', { inboxId: expect.any(Number) })
    expect(notify).toHaveBeenCalledWith('mail.received', expect.objectContaining({ type: 'mail.received' }))
    expect(res._body).toMatchObject({ from: 'user@a.com', subject: 'Hi', source: 'form' })
  })

  it('falls back to company when to is outside domain', async () => {
    const inbox = makeInbox()
    const res = makeRes()
    await inbox.inboxMail(makeReq({ from: 'u@a.com', to: 'x@other.com', subject: 'Hi' }), res)
    expect(res._body?.to).toBe(COMPANY)
  })

  it('keeps to when it matches mailgun domain', async () => {
    const inbox = makeInbox()
    const res = makeRes()
    await inbox.inboxMail(makeReq({ from: 'u@a.com', to: `sales@${DOMAIN}`, subject: 'Hi' }), res)
    expect(res._body?.to).toBe(`sales@${DOMAIN}`)
  })

  it('returns 400 on validation error', async () => {
    const inbox = makeInbox()
    const res = makeRes()
    await inbox.inboxMail(makeReq({ subject: 'No from' }), res)
    expect(res._status).toBe(400)
  })

  it('saves uploaded files and stores attachment URLs on the row', async () => {
    const saveBuffer = vi.fn(async (buf, name) => `/mail/attachments/uuid-${name}`)
    const inbox = makeInbox({ attachments: { saveBuffer } })
    const files = [
      { buffer: Buffer.from('a'), originalname: 'doc.pdf' },
      { buffer: Buffer.from('b'), originalname: 'img.png' },
    ]
    const res = makeRes()
    await inbox.inboxMail(makeReq({ from: 'u@a.com', subject: 'Hi' }, {}, files), res)

    expect(saveBuffer).toHaveBeenCalledTimes(2)
    expect(res._body?.attachments).toEqual(['/mail/attachments/uuid-doc.pdf', '/mail/attachments/uuid-img.png'])
  })

  it('extracts UTMs and passes to sessions.resolve', async () => {
    const sessions = { resolve: vi.fn(async () => null) }
    const inbox = makeInbox({ sessions })
    await inbox.inboxMail(
      makeReq({ from: 'a@b.com', subject: 'Q' }, { utm_source: 'google', utm_medium: 'cpc' }),
      makeRes()
    )
    expect(sessions.resolve).toHaveBeenCalledWith(null, { utm_source: 'google', utm_medium: 'cpc' })
  })

  it('links email to passport', async () => {
    const passports = { identify: vi.fn(async () => 'p1'), link: vi.fn(async () => {}) }
    const inbox = makeInbox({ passports })
    await inbox.inboxMail(makeReq({ from: 'user@a.com', subject: 'Hi' }), makeRes())
    expect(passports.link).toHaveBeenCalledWith(
      'passport-1',
      expect.arrayContaining([{ type: 'email', name: 'address', value: 'user@a.com' }])
    )
  })

  it('links phone field as a strong identity (E.164 normalized)', async () => {
    const passports = { identify: vi.fn(async () => 'p1'), link: vi.fn(async () => {}) }
    const inbox = makeInbox({ passports })
    await inbox.inboxMail(makeReq({
      from: 'user@a.com',
      subject: 'Hi',
      phone: '(555) 123-4567',
      country: 'US',
    }), makeRes())
    const claims = passports.link.mock.calls[0][1]
    expect(claims).toEqual(expect.arrayContaining([
      { type: 'phone', name: 'e164', value: '+15551234567' },
    ]))
  })

  it('links name and address as weak identities', async () => {
    const passports = { identify: vi.fn(async () => 'p1'), link: vi.fn(async () => {}) }
    const inbox = makeInbox({ passports })
    await inbox.inboxMail(makeReq({
      from: 'user@a.com',
      subject: 'Hi',
      name: 'Alice Johnson',
      address: '123 Main St, Springfield, IL',
    }), makeRes())
    const claims = passports.link.mock.calls[0][1]
    expect(claims).toEqual(expect.arrayContaining([
      { type: 'name', name: 'full', value: 'Alice Johnson' },
      { type: 'address', name: 'postal', value: '123 Main St, Springfield, IL' },
    ]))
  })

  it('accepts identity fields via data jsonb', async () => {
    const passports = { identify: vi.fn(async () => 'p1'), link: vi.fn(async () => {}) }
    const inbox = makeInbox({ passports })
    await inbox.inboxMail(makeReq({
      from: 'user@a.com',
      subject: 'Hi',
      data: {
        phone: '+44 20 7946 0000',
        name: 'Bob Smith',
        url: 'https://linkedin.com/in/bob',
      },
    }), makeRes())
    const claims = passports.link.mock.calls[0][1]
    expect(claims).toEqual(expect.arrayContaining([
      { type: 'phone', name: 'e164', value: '+442079460000' },
      { type: 'name', name: 'full', value: 'Bob Smith' },
      { type: 'url', name: 'link', value: 'https://linkedin.com/in/bob' },
    ]))
  })

  it('does NOT parse body text for phone numbers or URLs', async () => {
    // Reply bodies and signatures contain quoted threads, forwarded contact
    // info, and our own signature echoed back — never trust them.
    const passports = { identify: vi.fn(async () => 'p1'), link: vi.fn(async () => {}) }
    const inbox = makeInbox({ passports })
    await inbox.inboxMail(makeReq({
      from: 'user@a.com',
      subject: 'Hi',
      body: 'Hello, call me on +1 555 123 4567 or visit https://my-site.example/profile',
      country: 'US',
    }), makeRes())
    const claims = passports.link.mock.calls[0][1]
    expect(claims.filter(c => c.type === 'phone')).toHaveLength(0)
    expect(claims.filter(c => c.type === 'url')).toHaveLength(0)
  })

  it('deduplicates identical identities across top-level and data', async () => {
    const passports = { identify: vi.fn(async () => 'p1'), link: vi.fn(async () => {}) }
    const inbox = makeInbox({ passports })
    await inbox.inboxMail(makeReq({
      from: 'user@a.com',
      subject: 'Hi',
      phone: '+15551234567',
      data: { phone: '+15551234567' },   // same value, different source
    }), makeRes())
    const claims = passports.link.mock.calls[0][1]
    expect(claims.filter(c => c.type === 'phone')).toHaveLength(1)
  })

  it('silently ignores invalid phone numbers', async () => {
    const passports = { identify: vi.fn(async () => 'p1'), link: vi.fn(async () => {}) }
    const inbox = makeInbox({ passports })
    await inbox.inboxMail(makeReq({
      from: 'user@a.com',
      subject: 'Hi',
      phone: 'not-a-phone',
    }), makeRes())
    const claims = passports.link.mock.calls[0][1]
    expect(claims.filter(c => c.type === 'phone')).toHaveLength(0)
  })
})

describe('extractIdentities', () => {

  it('returns empty when no inputs match', () => {
    expect(extractIdentities({ from: null })).toEqual([])
  })

  it('always lowercases the email', () => {
    const claims = extractIdentities({ from: 'Alice@Example.COM' })
    expect(claims).toEqual([{ type: 'email', name: 'address', value: 'alice@example.com' }])
  })

  it('ignores body parameter entirely (signature lines are dangerous)', () => {
    const claims = extractIdentities({
      from: 'x@y.com',
      body: 'Call 555-123-4567 or visit https://malicious.example/track',
      country: 'US',
    })
    // Only email is extracted; body content is ignored
    expect(claims).toEqual([{ type: 'email', name: 'address', value: 'x@y.com' }])
  })

  it('normalizes international phone numbers via libphonenumber', () => {
    const claims = extractIdentities({ phone: '+44 20 7946 0000' })
    expect(claims).toEqual(expect.arrayContaining([
      { type: 'phone', name: 'e164', value: '+442079460000' },
    ]))
  })

  it('accepts data.urls array', () => {
    const claims = extractIdentities({
      data: { urls: ['https://a.example', 'https://b.example'] },
    })
    expect(claims.filter(c => c.type === 'url')).toHaveLength(2)
  })

  it('accepts single data.url string', () => {
    const claims = extractIdentities({
      data: { url: 'https://linkedin.com/in/alice' },
    })
    expect(claims).toEqual(expect.arrayContaining([
      { type: 'url', name: 'link', value: 'https://linkedin.com/in/alice' },
    ]))
  })
})
