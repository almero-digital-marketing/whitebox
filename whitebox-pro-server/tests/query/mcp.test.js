import { describe, it, expect } from 'vitest'
import { registerMcp } from '../../src/query/mcp.js'

// Capture registrations on a fake ctx.mcp so we can assert names + invoke the
// handlers directly with a stubbed selector — no real McpServer or engine needed.
function harness(selector) {
  const tools = {}
  registerMcp({ mcp: { tool: def => { tools[def.name] = def } } }, { selector })
  return tools
}
const parse = result => JSON.parse(result.content[0].text)

describe('query MCP surface', () => {
  it('registers exactly whitebox.query + whitebox.preview', () => {
    const tools = harness({})
    expect(Object.keys(tools).sort()).toEqual(['whitebox.preview', 'whitebox.query'])
  })

  it('query routes selector + opts straight to selector.resolve', async () => {
    let seen
    const selector = { resolve: async (sel, opts) => { seen = { sel, opts }; return { count: 1, passports: [{ id: 'p1' }] } } }
    const tools = harness(selector)
    const out = await tools['whitebox.query'].handler({
      selector: { about: 'pricing' }, projection: 'knowledge', scope: 'passport', passport: 'p1', limit: 5,
    })
    expect(seen.sel).toEqual({ about: 'pricing' })
    expect(seen.opts).toEqual({ projection: 'knowledge', scope: 'passport', passport: 'p1', limit: 5 })
    expect(parse(out)).toEqual({ count: 1, passports: [{ id: 'p1' }] })
  })

  it('preview routes to selector.preview', async () => {
    let seen
    const selector = { preview: async (sel, opts) => { seen = { sel, opts }; return { filter: { survivors: 3 } } } }
    const tools = harness(selector)
    const out = await tools['whitebox.preview'].handler({ selector: { about: 'x', judge: { criteria: 'y' } } })
    expect(seen.sel).toEqual({ about: 'x', judge: { criteria: 'y' } })
    expect(parse(out)).toEqual({ filter: { survivors: 3 } })
  })

  it('defaults a missing selector to {}', async () => {
    let seen
    const selector = { resolve: async (sel) => { seen = sel; return {} } }
    const tools = harness(selector)
    await tools['whitebox.query'].handler({ projection: 'people' })
    expect(seen).toEqual({})
  })

  it('the query tool tells the agent to synthesize answers itself (no ask tool)', () => {
    const tools = harness({})
    expect(tools['whitebox.query'].description).toMatch(/synthesize the answer yourself/i)
    expect(tools).not.toHaveProperty('whitebox.ask')
  })
})
