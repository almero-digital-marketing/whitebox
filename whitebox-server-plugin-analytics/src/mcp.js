// MCP capability registrations for the analytics plugin.
//
// These are the most LLM-relevant tools in whitebox. An external agent
// (Claude desktop, agentic IDE, internal Claude SDK loop) connected over
// MCP can ask grounded questions about any customer using the same
// retrieval primitives the HTTP /analytics endpoints expose — but with
// the tool descriptions and JSON Schema tuned for LLM consumption.
//
// `whitebox.ask` delegates to the core awareness.ask primitive — the same call
// the HTTP /ask endpoint makes — so the synthesis behaviour stays in lockstep.

import { z } from 'zod'

export function registerMcp(ctx, { awareness, context }) {
  if (!ctx.mcp) return

  ctx.mcp.tool({
    name: 'whitebox.ask',
    description: 'Answer a natural-language question about a single customer. Returns a grounded synthesis built from semantic recall (mail / voip / web / crm content history) plus current structured context (CRM rows). Cites timestamps. The single most useful tool for understanding a customer.',
    inputSchema: {
      passport_id: z.string().uuid(),
      question:    z.string().min(1),
      limit:       z.number().int().positive().max(50).optional(),
    },
    handler: async (args) => {
      const result = await awareness.ask(args)
      return { content: [{ type: 'text', text: result.answer }] }
    },
  })

  ctx.mcp.tool({
    name: 'whitebox.recall',
    description: 'Per-passport semantic search. Returns the top-K content chunks (mail bodies, web reads, call transcripts, CRM notes) most relevant to a query, ranked by vector similarity. Each hit includes channel, direction, timestamp, and UTM attribution when available.',
    inputSchema: {
      passport_id: z.string().uuid(),
      query:       z.string().min(1),
      limit:       z.number().int().positive().max(100).optional(),
    },
    handler: async ({ passport_id, query, limit = 10 }) => {
      const hits = await awareness.recall({ passport_id, query, limit })
      return { content: [{ type: 'text', text: JSON.stringify(hits, null, 2) }] }
    },
  })

  ctx.mcp.tool({
    name: 'whitebox.population',
    description: 'Cohort awareness — how many distinct customers have content matching a concept, above a similarity threshold. Useful for "how many people have we told about X?" style questions.',
    inputSchema: {
      query:      z.string().min(1),
      similarity: z.number().min(0).max(1).optional(),
      limit:      z.number().int().positive().max(10000).optional(),
    },
    handler: async (args) => {
      const result = await awareness.population(args)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  })

  ctx.mcp.tool({
    name: 'whitebox.timeline',
    description: 'Flat content timeline for a single passport, newest first. Returns raw exposures (no embedding work). Filter by channel (mail / voip / web / crm), direction (exposure / expression / conversation / observation), and date range.',
    inputSchema: {
      passport_id: z.string().uuid(),
      from:        z.string().datetime().optional(),
      to:          z.string().datetime().optional(),
      channels:    z.array(z.string()).optional(),
      directions:  z.array(z.string()).optional(),
    },
    handler: async ({ passport_id, from, to, channels, directions }) => {
      const rows = await awareness.timeline({
        passport_id,
        from: from ? new Date(from) : null,
        to:   to   ? new Date(to)   : null,
        channels:   channels   ?? null,
        directions: directions ?? null,
      })
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] }
    },
  })

  ctx.mcp.tool({
    name: 'whitebox.context',
    description: 'Inspect the structured context registry for a passport — what every plugin (crm, billing, …) currently knows. This is what whitebox.ask sees before the LLM step; useful for debugging "why didn\'t the answer mention X?".',
    inputSchema: {
      passport_id: z.string().uuid(),
      providers:   z.array(z.string()).optional(),
      limit:       z.number().int().positive().max(200).optional(),
    },
    handler: async ({ passport_id, providers, limit = 20 }) => {
      if (!context?.collect) {
        return { content: [{ type: 'text', text: JSON.stringify({ providers: [], context: {} }, null, 2) }] }
      }
      const collected = await context.collect(passport_id, { providers, limit })
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            providers: providers ?? context.names?.() ?? Object.keys(collected),
            context:   collected,
          }, null, 2),
        }],
      }
    },
  })

  ctx.mcp.tool({
    name: 'whitebox.forget',
    description: 'GDPR forget — deletes all awareness exposures + orphan chunks for a passport. Cascades through every channel. Irreversible. Use with caution from an LLM context; consider gating on a separate confirmation tool call in production.',
    inputSchema: {
      passport_id: z.string().uuid(),
    },
    handler: async ({ passport_id }) => {
      const deleted = await awareness.forget({ passport_id })
      return { content: [{ type: 'text', text: `Forgot passport ${passport_id} — ${deleted} exposure(s) deleted` }] }
    },
  })
}
