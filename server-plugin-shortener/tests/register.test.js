import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import { shortener } from '../src/index.js'

function makeMcp() {
  const tools = new Map(), resources = new Map()
  return { tool: s => tools.set(s.name, s), resource: s => resources.set(s.name, s), prompt() {}, tools, resources }
}
const logger = { child() { return this }, info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

describe('shortener plugin — register', () => {
  it('wires routes + MCP and derives the short host from baseUrl', async () => {
    const mcp = makeMcp()
    const ctx = { db: {}, passports: {}, awareness: { record: vi.fn() }, mcp, logger }
    const api = await shortener({ baseUrl: 'https://go.clinic.com', auth: { secret: 's' } }).register(express(), ctx)
    expect(api).toHaveProperty('service')
    expect([...mcp.tools.keys()].sort()).toEqual([
      'shortener.create_link', 'shortener.link_stats', 'shortener.list_links',
    ])
  })

  it('warns but still loads when no baseUrl is configured (redirect disabled)', async () => {
    const ctx = { db: {}, passports: {}, awareness: { record: vi.fn() }, logger }
    await expect(shortener({}).register(express(), ctx)).resolves.toBeDefined()
    expect(logger.warn).toHaveBeenCalled()
  })
})
