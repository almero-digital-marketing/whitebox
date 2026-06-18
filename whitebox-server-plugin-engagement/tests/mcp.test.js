import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import { engagement } from '../src/index.js'

// Capture-everything MCP registry stand-in.
function makeMcpStub() {
  const tools = new Map()
  const resources = new Map()
  return {
    tool:     (spec) => tools.set(spec.name, spec),
    resource: (spec) => resources.set(spec.name, spec),
    prompt:   () => {},
    tools, resources,
  }
}

// Minimal db stub — knex-chain compatible.
function dbStub({ rows = [] } = {}) {
  const chain = {
    where:        () => chain,
    orderBy:      () => chain,
    limit:        () => Promise.resolve(rows),
    first:        () => Promise.resolve(rows[0] ?? null),
    del:          () => Promise.resolve(rows.length),
    insert:       () => ({ onConflict: () => ({ merge: () => ({ returning: () => Promise.resolve(rows) }) }) }),
  }
  const db = () => chain
  db.migrate = { latest: async () => {} }
  db.schema  = { hasTable: async () => true }
  return db
}

const logger = { child() { return this }, info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

describe('engagement plugin — MCP registration', () => {
  it('registers list/get/invalidate tools and the content resource', async () => {
    const mcp = makeMcpStub()
    const ctx = {
      db:        dbStub(),
      connect:   { find: vi.fn(), onConnected: vi.fn(), onDisconnected: vi.fn(), onMessage: vi.fn() },
      awareness: { record: vi.fn() },
      ai:    {},
      mcp,
      logger,
    }
    await engagement({ auth: { secret: 's' } }).register(express(), ctx)

    expect([...mcp.tools.keys()].sort()).toEqual([
      'engagement.get_content',
      'engagement.invalidate_content',
      'engagement.list_content',
    ])
    expect([...mcp.resources.keys()]).toEqual(['engagement-content'])
  })

  it('list_content handler returns a JSON summary of cached entries', async () => {
    const mcp = makeMcpStub()
    const rows = [
      { url: 'https://x/a', kind: 'video', generated_at: new Date('2026-05-01'), text: 'long text', segments: [{}, {}] },
      { url: 'https://x/b', kind: 'image', generated_at: new Date('2026-05-02'), text: 'caption', segments: null },
    ]
    const ctx = {
      db:     dbStub({ rows }),
      connect:{ find: vi.fn(), onConnected: vi.fn(), onDisconnected: vi.fn(), onMessage: vi.fn() },
      awareness: { record: vi.fn() },
      ai: {}, mcp, logger,
    }
    await engagement({ auth: { secret: 's' } }).register(express(), ctx)

    const result = await mcp.tools.get('engagement.list_content').handler({})
    const items = JSON.parse(result.content[0].text)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ url: 'https://x/a', kind: 'video', text_chars: 9, segments: 2 })
    expect(items[1]).toMatchObject({ url: 'https://x/b', kind: 'image', text_chars: 7, segments: 0 })
  })

  it('get_content returns isError when url is unknown', async () => {
    const mcp = makeMcpStub()
    const ctx = {
      db:     dbStub({ rows: [] }),                  // first() will resolve to null
      connect:{ find: vi.fn(), onConnected: vi.fn(), onDisconnected: vi.fn(), onMessage: vi.fn() },
      awareness: { record: vi.fn() },
      ai: {}, mcp, logger,
    }
    await engagement({ auth: { secret: 's' } }).register(express(), ctx)

    const result = await mcp.tools.get('engagement.get_content').handler({ url: 'https://nope.example' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('No cached content')
  })

  it('plugin loads cleanly when ctx.mcp is undefined (mcp is optional)', async () => {
    const ctx = {
      db:     dbStub(),
      connect:{ find: vi.fn(), onConnected: vi.fn(), onDisconnected: vi.fn(), onMessage: vi.fn() },
      awareness: { record: vi.fn() },
      ai: {}, /* mcp absent */ logger,
    }
    await expect(engagement({ auth: { secret: 's' } }).register(express(), ctx)).resolves.not.toThrow()
  })
})
