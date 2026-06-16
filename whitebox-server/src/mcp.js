// MCP — Model Context Protocol server, mounted as one HTTP endpoint on the
// whitebox Express app. Plugins register capabilities (tools, resources,
// prompts) via ctx.mcp.tool / resource / prompt during their register()
// phase, before the transport is mounted.
//
// Transport: Streamable HTTP, stateless mode (no sessionId multiplexing —
// each request stands alone). One McpServer instance for the whole process;
// every request reuses it.
//
// Auth: a single bearer token gates the endpoint. Any client with the token
// can invoke any registered capability. Per-tool ACLs are a follow-up.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

// Dependencies + state captured once via init() — module-level singleton, no
// wrapping factory closure. Matches the core pattern (passports, sessions, …).
// init() builds a FRESH McpServer and registration ledger every call: the SDK
// throws if a tool name is registered twice on one server, so a clean rebuild
// is what keeps re-init (and per-test isolation) sound.
let logger
let enabled
let server
let registered = { tools: [], resources: [], prompts: [] }

export function init({ config = {}, logger: log } = {}) {
  logger = log
  enabled = config.enabled !== false

  // The McpServer instance. Plugins register capabilities on this during
  // ctx.mcp.tool/resource/prompt; the transport pipes JSON-RPC frames
  // through it on each request.
  server = new McpServer(
    {
      name:    config.name    || 'whitebox',
      version: config.version || '2.0.0',
    },
    {
      capabilities: { logging: {} },
    },
  )

  // Track registrations locally so /mcp/inspect (and tests) can list what's
  // available without reaching into McpServer internals.
  registered = { tools: [], resources: [], prompts: [] }
}

// Register a tool. `inputSchema` is a ZodRawShape (plain object of Zod
// schemas, NOT z.object(...) — the SDK wraps it). `handler(args)` returns
// an MCP CallToolResult: `{ content: [{ type: 'text', text: '...' }] }`.
export function tool({ name, description, inputSchema, outputSchema, annotations, handler }) {
  if (!enabled) return
  if (!name)    throw new Error('mcp.tool: name is required')
  if (!handler) throw new Error('mcp.tool: handler is required')

  server.registerTool(
    name,
    {
      description,
      inputSchema,
      outputSchema,
      annotations,
    },
    async (args, extra) => {
      try {
        return await handler(args, extra)
      } catch (err) {
        logger?.error?.({ err, name }, 'MCP tool failed')
        return {
          isError: true,
          content: [{ type: 'text', text: String(err?.message ?? err) }],
        }
      }
    },
  )
  registered.tools.push(name)
}

// Register a resource at a static URI. For templated URIs, pass a
// ResourceTemplate instance (imported from @modelcontextprotocol/sdk).
export function resource({ name, uri, description, mimeType, handler }) {
  if (!enabled) return
  if (!name) throw new Error('mcp.resource: name is required')
  if (!uri)  throw new Error('mcp.resource: uri is required')

  server.registerResource(
    name,
    uri,
    { description, mimeType },
    async (parsedUri, extra) => {
      try {
        return await handler(parsedUri, extra)
      } catch (err) {
        logger?.error?.({ err, name, uri }, 'MCP resource read failed')
        throw err
      }
    },
  )
  registered.resources.push(name)
}

// Register a prompt template. `argsSchema` is a ZodRawShape; `handler`
// returns `{ messages: [{ role, content }] }`.
export function prompt({ name, description, argsSchema, handler }) {
  if (!enabled) return
  if (!name)    throw new Error('mcp.prompt: name is required')
  if (!handler) throw new Error('mcp.prompt: handler is required')

  server.registerPrompt(
    name,
    { description, argsSchema },
    async (args, extra) => handler(args, extra),
  )
  registered.prompts.push(name)
}

// Wire the single shared McpServer to a Streamable HTTP transport and
// mount the three required Express handlers (POST/GET/DELETE). Stateless
// mode: sessionIdGenerator is omitted, each request is independent.
export async function mount(app, { path = '/mcp', auth } = {}) {
  if (!enabled) {
    logger?.info?.('MCP disabled — endpoint not mounted')
    return
  }
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  })
  await server.connect(transport)

  const middlewares = auth ? [auth] : []
  app.post(path,   ...middlewares, (req, res) => transport.handleRequest(req, res, req.body))
  app.get(path,    ...middlewares, (req, res) => transport.handleRequest(req, res))
  app.delete(path, ...middlewares, (req, res) => transport.handleRequest(req, res))

  logger?.info?.('MCP mounted at %s (%d tools, %d resources, %d prompts)',
    path, registered.tools.length, registered.resources.length, registered.prompts.length)
}

// Snapshot of registered capability names — useful for tests + a future
// /mcp/inspect admin endpoint.
export function inspect() {
  return {
    tools:     [...registered.tools],
    resources: [...registered.resources],
    prompts:   [...registered.prompts],
    enabled,
  }
}
