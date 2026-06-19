import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import { mail } from '../src/index.js'

function makeMcpStub() {
  const tools = new Map(), resources = new Map()
  return {
    tool:     (s) => tools.set(s.name, s),
    resource: (s) => resources.set(s.name, s),
    prompt:   () => {},
    tools, resources,
  }
}

// Minimal db stand-in. Returns a chain that resolves to `rows` or `first`.
function dbStub({ rows = [] } = {}) {
  const chain = {
    where:    () => chain,
    orderBy:  () => chain,
    limit:    () => chain,
    select:   () => Promise.resolve(rows),
    first:    () => Promise.resolve(rows[0] ?? null),
    insert:   () => ({ onConflict: () => ({ merge: () => ({ returning: () => Promise.resolve(rows) }) }) }),
    del:      () => Promise.resolve(rows.length),
    update:   () => Promise.resolve(rows.length),
    then:     (resolve) => resolve(rows),                                 // makes plain `await q` resolve to rows
  }
  const db = () => chain
  db.migrate = { latest: async () => {} }
  db.schema  = { hasTable: async () => true }
  db.fn      = { now: () => new Date() }
  return db
}

const logger = { child() { return this }, info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

// The mail plugin options — passed to the factory, mail(mailConfig()).
function mailConfig(overrides = {}) {
  return {
    attachmentsFolder: '/tmp/wb-mail-test',
    company: 'info@test',
    // A composed mail provider — only the contract shape matters here.
    provider: {
      name: 'stub',
      send: vi.fn(async () => ({ messageId: 'x' })),
      verifySignature: vi.fn(() => true),
      parseInbound: vi.fn(() => ({})),
      parseTracking: vi.fn(() => null),
    },
    webhooks: [],
    auth: { secret: 's' },
    outbox: { stuckCheckIntervalMs: 0 },                                  // disable reaper timer
    ...overrides,
  }
}

// Stand-ins for every ctx field the mail plugin reads
function makeCtx({ mcp, db } = {}) {
  return {
    db: db || dbStub(),
    queue: {
      createQueue:  () => ({ add: vi.fn(async () => {}) }),
      createWorker: () => ({ on: vi.fn(() => ({ on: vi.fn() })), close: vi.fn() }),
    },
    events:   { emit: vi.fn(), on: vi.fn() },
    webhooks: { dispatch: vi.fn() },
    passports: { identify: vi.fn(), link: vi.fn() },
    sessions:  { resolve: vi.fn() },
    templates: {},
    awareness: { record: vi.fn() },
    mcp,
    logger,
  }
}

describe('mail plugin — MCP registration', () => {
  it('registers the expected tools and one resource', async () => {
    const mcp = makeMcpStub()
    await mail(mailConfig()).register(express(), makeCtx({ mcp }))
    expect([...mcp.tools.keys()].sort()).toEqual([
      'mail.inbox_get',
      'mail.inbox_list',
      'mail.outbox_get',
      'mail.send',
      'mail.suppress',
      'mail.unsuppress',
    ])
    expect([...mcp.resources.keys()]).toEqual(['mail-inbox'])
  })

  it('inbox_get returns isError when id is unknown', async () => {
    const mcp = makeMcpStub()
    await mail(mailConfig()).register(express(), makeCtx({ mcp, db: dbStub({ rows: [] }) }))
    const result = await mcp.tools.get('mail.inbox_get').handler({ id: 9999 })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('No inbox row')
  })

  it('inbox_list returns compact JSON of the matching rows', async () => {
    const mcp = makeMcpStub()
    const rows = [
      { id: 2, from: 'b@x', subject: 'Re: x', source: 'inbound', received_at: new Date('2026-05-02'), passport_id: 'p2' },
      { id: 1, from: 'a@x', subject: 'Hi',    source: 'form',    received_at: new Date('2026-05-01'), passport_id: 'p1' },
    ]
    await mail(mailConfig()).register(express(), makeCtx({ mcp, db: dbStub({ rows }) }))
    const result = await mcp.tools.get('mail.inbox_list').handler({})
    const items = JSON.parse(result.content[0].text)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ id: 2, source: 'inbound' })
  })

  it('plugin loads cleanly when ctx.mcp is undefined', async () => {
    await expect(mail(mailConfig()).register(express(), makeCtx({}))).resolves.not.toThrow()
  })
})
