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

function makeState({ current = {} } = {}) {
  return { current: vi.fn(async () => current) }
}

describe('crm plugin — MCP registration', () => {
  it('registers three tools (write record, add note, read state) and no resource', () => {
    const mcp = makeMcpStub()
    registerMcp({ mcp }, { state: makeState(), ingest: makeIngest() })
    expect([...mcp.tools.keys()].sort()).toEqual([
      'crm.add_fact',
      'crm.get_state',
      'crm.upsert_record',
    ])
    expect([...mcp.resources.keys()]).toEqual([])
  })

  it('upsert_record passes args through to ingestRecords and reports new vs reused passport', async () => {
    const mcp = makeMcpStub()
    const ingest = makeIngest({
      recordsResult: { passport_id: 'p-7', passport_created: true, records: { accepted: 1, dropped: 0 } },
    })
    registerMcp({ mcp }, { state: makeState(), ingest })

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
    registerMcp({ mcp }, { state: makeState(), ingest })

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
    registerMcp({ mcp }, { state: makeState(), ingest })

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

  it('get_state returns the passport\'s current facts', async () => {
    const mcp = makeMcpStub()
    registerMcp({ mcp }, { state: makeState({ current: { subscription: 'active', plan_tier: 'pro' } }), ingest: makeIngest() })

    const result = await mcp.tools.get('crm.get_state').handler({ passport_id: 'p-1' })
    expect(JSON.parse(result.content[0].text)).toEqual({ subscription: 'active', plan_tier: 'pro' })
  })

  it('is a no-op when ctx.mcp is undefined', () => {
    expect(() => registerMcp({}, { state: makeState(), ingest: makeIngest() })).not.toThrow()
  })
})
