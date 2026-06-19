import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import { voip } from '../src/index.js'

function makeMcpStub() {
  const tools = new Map(), resources = new Map()
  return {
    tool:     (s) => tools.set(s.name, s),
    resource: (s) => resources.set(s.name, s),
    prompt:   () => {},
    tools, resources,
  }
}

// Knex-chain shaped stub that resolves to `rows` for both `select(...)` and
// awaited terminal calls.
function dbStub({ rows = [], single = null } = {}) {
  const chain = {
    where:   () => chain,
    orderBy: () => chain,
    limit:   () => chain,
    select:  () => Promise.resolve(rows),
    first:   () => Promise.resolve(single),
    update:  () => Promise.resolve(rows.length),
    insert:  () => Promise.resolve(rows.length),
    then:    (resolve) => resolve(rows),
  }
  const db = () => chain
  db.migrate = { latest: async () => {} }
  db.schema  = { hasTable: async () => true }
  db.fn      = { now: () => new Date() }
  return db
}

const logger = { child() { return this }, info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

// The voip plugin options — passed to the factory, voip(voipConfig()).
function voipConfig(overrides = {}) {
  return {
    ari: { url: 'http://pbx.test:8088', user: 'u', password: 'p', app: 'whitebox' },
    recordsFolder: '/tmp/wb-voip-test',
    url: 'https://example.com',
    country: 'US',
    language: 'en-US',
    transcription: false,
    lines: { default: ['+15551111111'] },
    webhooks: [],
    ...overrides,
  }
}

// Stand-ins for every ctx field the voip plugin reads. ARI connect would
// reach a real PBX in production — we stub the ari module entirely so
// register() just records MCP capabilities without opening a socket.
function makeCtx({ mcp, db, single } = {}) {
  return {
    config: { ai: {} },   // factory spreads ctx.config so sub-modules see config.ai
    db: db || dbStub({ single }),
    webhooks: { dispatch: vi.fn() },
    events:   { emit: vi.fn(), on: vi.fn() },
    connect:  { onConnected: vi.fn(), onDisconnected: vi.fn(), onMessage: vi.fn(), find: vi.fn(), emit: vi.fn() },
    passports: { identify: vi.fn(), link: vi.fn() },
    sessions:  { resolve: vi.fn() },
    ai:    {},
    awareness: { record: vi.fn() },
    mcp,
    logger,
  }
}

// Stub the ARI module so register() doesn't try to open a real WebSocket.
// The converted modules export `init` (and friends) directly, so the mock
// factories replace those named exports.
vi.mock('../src/ari.js', () => ({
  init: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
}))
vi.mock('../src/encoder.js', () => ({
  init: vi.fn(),
  encode: vi.fn(),
  duration: vi.fn(),
}))

describe('voip plugin — MCP registration', () => {
  it('registers list_calls / get_call / get_transcript tools and the voip-calls resource', async () => {
    const mcp = makeMcpStub()
    await voip(voipConfig()).register(express(), makeCtx({ mcp }))
    expect([...mcp.tools.keys()].sort()).toEqual([
      'voip.get_call',
      'voip.get_transcript',
      'voip.list_calls',
    ])
    expect([...mcp.resources.keys()]).toEqual(['voip-calls'])
  })

  it('list_calls returns rows as compact JSON', async () => {
    const mcp = makeMcpStub()
    const rows = [
      { vault_id: 'v1', caller: '+1', line: '+2', status: 'ended', duration: 47 },
      { vault_id: 'v2', caller: '+3', line: '+4', status: 'missed', duration: null },
    ]
    await voip(voipConfig()).register(express(), makeCtx({ mcp, db: dbStub({ rows }) }))
    const result = await mcp.tools.get('voip.list_calls').handler({ limit: 10 })
    const items = JSON.parse(result.content[0].text)
    expect(items).toHaveLength(2)
    expect(items[0].vault_id).toBe('v1')
  })

  it('get_call returns isError when vault_id is unknown', async () => {
    const mcp = makeMcpStub()
    await voip(voipConfig()).register(express(), makeCtx({ mcp, db: dbStub({ single: null }) }))
    const result = await mcp.tools.get('voip.get_call').handler({ vault_id: 'nope' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('No call with vault_id')
  })

  it('get_transcript returns empty string when the call has none', async () => {
    const mcp = makeMcpStub()
    const single = { vault_id: 'v1', transcription: null }
    await voip(voipConfig()).register(express(), makeCtx({ mcp, db: dbStub({ single }) }))
    const result = await mcp.tools.get('voip.get_transcript').handler({ vault_id: 'v1' })
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toBe('')
  })

  it('plugin loads cleanly when ctx.mcp is undefined', async () => {
    await expect(voip(voipConfig()).register(express(), makeCtx({}))).resolves.not.toThrow()
  })
})
