import { describe, it, expect, vi } from 'vitest'
import { registerMcp } from '../src/mcp.js'

function makeMcpStub() {
  const tools = new Map(), resources = new Map()
  return {
    tool:     (s) => tools.set(s.name, s),
    resource: (s) => resources.set(s.name, s),
    prompt:   () => {},
    tools, resources,
  }
}

function makeIngest({
  recordsResult = { passport_id: 'p-1', passport_created: false, records: { accepted: 1, dropped: 0 } },
  factsResult   = { passport_id: 'p-1', passport_created: false, facts:   { accepted: 1, dropped: 0 } },
} = {}) {
  return {
    ingestRecords: vi.fn(async () => recordsResult),
    ingestFacts:   vi.fn(async () => factsResult),
  }
}

function makeRecords({ rows = [], single = null } = {}) {
  return {
    listForPassport: vi.fn(async () => rows),
    find:            vi.fn(async () => single),
  }
}

describe('crm plugin — MCP registration', () => {
  it('registers four tools and one resource', () => {
    const mcp = makeMcpStub()
    registerMcp({ mcp }, { records: makeRecords(), ingest: makeIngest() })
    expect([...mcp.tools.keys()].sort()).toEqual([
      'crm.add_fact',
      'crm.get_record',
      'crm.list_records',
      'crm.upsert_record',
    ])
    expect([...mcp.resources.keys()]).toEqual(['crm-records'])
  })

  it('upsert_record passes args through to ingestRecords and reports new vs reused passport', async () => {
    const mcp = makeMcpStub()
    const ingest = makeIngest({
      recordsResult: { passport_id: 'p-7', passport_created: true, records: { accepted: 1, dropped: 0 } },
    })
    registerMcp({ mcp }, { records: makeRecords(), ingest })

    const result = await mcp.tools.get('crm.upsert_record').handler({
      source: 'booking',
      customer: { email: 'a@b.com' },
      kind: 'reservation', external_id: 'r1',
      status: 'confirmed', data: { room: 'suite' },
    })
    expect(ingest.ingestRecords).toHaveBeenCalledWith({
      source: 'booking',
      customer: { email: 'a@b.com' },
      records: [{ kind: 'reservation', external_id: 'r1', status: 'confirmed', starts_at: undefined, data: { room: 'suite' } }],
    })
    expect(result.content[0].text).toMatch(/p-7.*new/)
  })

  it('upsert_record returns isError when ingest drops for no_identity', async () => {
    const mcp = makeMcpStub()
    const ingest = makeIngest({
      recordsResult: { reason: 'no_identity', records: { accepted: 0, dropped: 1 } },
    })
    registerMcp({ mcp }, { records: makeRecords(), ingest })

    const result = await mcp.tools.get('crm.upsert_record').handler({
      source: 'booking', customer: {},
      kind: 'reservation', external_id: 'r1',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/no identifying info/)
  })

  it('add_fact routes through ingestFacts with ref payload intact', async () => {
    const mcp = makeMcpStub()
    const ingest = makeIngest()
    registerMcp({ mcp }, { records: makeRecords(), ingest })

    await mcp.tools.get('crm.add_fact').handler({
      source: 'hubspot',
      customer: { email: 'c@d.com' },
      id: 'note-7', kind: 'note', body: 'Called, interested',
      ref: { kind: 'deal', external_id: 'd-42' },
    })
    expect(ingest.ingestFacts).toHaveBeenCalledWith({
      source: 'hubspot',
      customer: { email: 'c@d.com' },
      facts: [{ id: 'note-7', kind: 'note', body: 'Called, interested', ts: undefined, ref: { kind: 'deal', external_id: 'd-42' } }],
    })
  })

  it('list_records projects to the compact public shape', async () => {
    const mcp = makeMcpStub()
    const rows = [
      { id: 1, source: 'booking', kind: 'reservation', external_id: 'r1',
        status: 'confirmed', starts_at: new Date('2026-06-12'),
        data: { room: 'suite' }, passport_id: 'p-1', updated_at: new Date() },
    ]
    registerMcp({ mcp }, { records: makeRecords({ rows }), ingest: makeIngest() })

    const result = await mcp.tools.get('crm.list_records').handler({ passport_id: 'p-1' })
    const items = JSON.parse(result.content[0].text)
    expect(items[0]).toEqual({
      source: 'booking', kind: 'reservation', external_id: 'r1',
      status: 'confirmed', starts_at: rows[0].starts_at.toISOString(),
      data: { room: 'suite' },
    })
    // id, passport_id, updated_at NOT leaked
    expect(items[0]).not.toHaveProperty('id')
    expect(items[0]).not.toHaveProperty('passport_id')
  })

  it('get_record returns isError when the row is missing', async () => {
    const mcp = makeMcpStub()
    registerMcp({ mcp }, { records: makeRecords({ single: null }), ingest: makeIngest() })
    const result = await mcp.tools.get('crm.get_record').handler({
      source: 'booking', kind: 'reservation', external_id: 'nope',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/No record booking\/reservation\/nope/)
  })

  it('is a no-op when ctx.mcp is undefined', () => {
    expect(() => registerMcp({}, { records: makeRecords(), ingest: makeIngest() })).not.toThrow()
  })
})
