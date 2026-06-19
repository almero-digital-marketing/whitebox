import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import * as mcp from '../src/mcp.js'

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

// mcp is now an init + module-singleton module. init() builds a FRESH McpServer
// and registration ledger every call, so per-test isolation holds (registering
// the same tool name twice across tests on one server would otherwise throw).
function createMcp(opts = {}) {
  mcp.init(opts)
  return mcp
}

describe('mcp registry', () => {
  it('tool() registers and records the name', () => {
    const mcp = createMcp({ logger })
    mcp.tool({
      name: 'demo.echo',
      description: 'echo input',
      inputSchema: { msg: z.string() },
      handler: async ({ msg }) => ({ content: [{ type: 'text', text: msg }] }),
    })
    expect(mcp.inspect().tools).toContain('demo.echo')
  })

  it('resource() records the registration', () => {
    const mcp = createMcp({ logger })
    mcp.resource({
      name: 'demo.greeting',
      uri: 'whitebox://demo/hi',
      description: 'a greeting',
      handler: async (uri) => ({
        contents: [{ uri: String(uri), text: 'hello' }],
      }),
    })
    expect(mcp.inspect().resources).toContain('demo.greeting')
  })

  it('prompt() records the registration', () => {
    const mcp = createMcp({ logger })
    mcp.prompt({
      name: 'demo.summarize',
      description: 'summarize',
      argsSchema: { topic: z.string() },
      handler: async ({ topic }) => ({
        messages: [{ role: 'user', content: { type: 'text', text: `Summarize ${topic}` } }],
      }),
    })
    expect(mcp.inspect().prompts).toContain('demo.summarize')
  })

  it('all registration methods are no-ops when enabled:false', () => {
    const mcp = createMcp({ config: { enabled: false }, logger })
    mcp.tool({ name: 'x', handler: async () => ({}), inputSchema: {} })
    mcp.resource({ name: 'y', uri: 'wb://y', handler: async () => ({}) })
    mcp.prompt({ name: 'z', handler: async () => ({}) })
    expect(mcp.inspect()).toEqual({ tools: [], resources: [], prompts: [], enabled: false })
  })

  it('mount() is a no-op when enabled:false (does not throw, does not bind routes)', async () => {
    const mcp = createMcp({ config: { enabled: false }, logger })
    const post = vi.fn(), get = vi.fn(), del = vi.fn()
    const app = { post, get, delete: del }
    await mcp.mount(app, { path: '/mcp' })
    expect(post).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
    expect(del).not.toHaveBeenCalled()
  })

  it('mount() wires POST/GET/DELETE handlers on the given path', async () => {
    const mcp = createMcp({ logger })
    mcp.tool({
      name: 'x',
      description: 'x',
      inputSchema: {},
      handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    })
    const post = vi.fn(), get = vi.fn(), del = vi.fn()
    const app = { post, get, delete: del }
    await mcp.mount(app, { path: '/mcp' })
    expect(post).toHaveBeenCalledWith('/mcp', expect.any(Function))
    expect(get).toHaveBeenCalledWith('/mcp', expect.any(Function))
    expect(del).toHaveBeenCalledWith('/mcp', expect.any(Function))
  })

  it('mount() inserts auth middleware before the handler when provided', async () => {
    const mcp = createMcp({ logger })
    const post = vi.fn(), get = vi.fn(), del = vi.fn()
    const app = { post, get, delete: del }
    const auth = (req, res, next) => next()
    await mcp.mount(app, { path: '/mcp', auth })
    expect(post).toHaveBeenCalledWith('/mcp', auth, expect.any(Function))
    expect(get).toHaveBeenCalledWith('/mcp', auth, expect.any(Function))
    expect(del).toHaveBeenCalledWith('/mcp', auth, expect.any(Function))
  })

  it('rejects bad registrations early', () => {
    const mcp = createMcp({ logger })
    expect(() => mcp.tool({})).toThrow(/name/)
    expect(() => mcp.tool({ name: 'x' })).toThrow(/handler/)
    expect(() => mcp.resource({})).toThrow(/name/)
    expect(() => mcp.resource({ name: 'x' })).toThrow(/uri/)
    expect(() => mcp.prompt({})).toThrow(/name/)
  })

  it('inspect() reflects current state', () => {
    const mcp = createMcp({ logger })
    mcp.tool({ name: 'a', inputSchema: {}, handler: async () => ({}) })
    mcp.tool({ name: 'b', inputSchema: {}, handler: async () => ({}) })
    mcp.resource({ name: 'r', uri: 'wb://r', handler: async () => ({}) })
    const s = mcp.inspect()
    expect(s.tools.sort()).toEqual(['a', 'b'])
    expect(s.resources).toEqual(['r'])
    expect(s.enabled).toBe(true)
  })
})
