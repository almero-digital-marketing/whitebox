import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import { conversions } from '../src/index.js'
import { meta } from 'whitebox-pro-adnetworks-meta'

function makeMcp() {
  const tools = new Map(), resources = new Map()
  return { tool: s => tools.set(s.name, s), resource: s => resources.set(s.name, s), prompt() {}, tools, resources }
}

const logger = { child() { return this }, info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

describe('conversions plugin — register', () => {
  it('wires routes + MCP without throwing when no networks are configured', async () => {
    const mcp = makeMcp()
    const ctx = {
      db: {},                                   // migrate() isn't called by register()
      passports: { identities: vi.fn(async () => []) },
      awareness: { record: vi.fn(async () => {}) },
      mcp,
      logger,
    }
    const api = await conversions({}).register(express(), ctx)
    expect(api).toHaveProperty('reporter')
    expect([...mcp.tools.keys()]).toContain('conversions.list_events')
    expect([...mcp.resources.keys()]).toContain('conversions-events')
  })

  it('reports configured-but-ineligible networks as not eligible', async () => {
    const ctx = {
      db: {}, passports: { identities: vi.fn(async () => []) },
      awareness: { record: vi.fn() }, logger,
    }
    // meta composed but missing accessToken ⇒ ineligible, no throw.
    const { reporter } = await conversions({ networks: [meta({ pixelId: 'x' })] }).register(express(), ctx)
    expect(reporter.networks()).toEqual([expect.objectContaining({ name: 'meta', eligible: false })])
  })
})
