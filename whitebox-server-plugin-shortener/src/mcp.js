// MCP — let an LLM operator mint and inspect tracked links
// ("make a tracked link to the whitening page for jane@example.com").

import { z } from 'zod'

export function registerMcp(ctx, { service }) {
  if (!ctx.mcp) return

  ctx.mcp.tool({
    name: 'shortener.create_link',
    description: 'Create a short link that hides a passport behind an opaque code. A personalized link (passport_id or identify) hard-binds the clicker\'s session to that customer; a plain link just redirects. Returns { code, short_url }.',
    inputSchema: {
      url:         z.string().url(),
      passport_id: z.string().uuid().optional(),
      identify:    z.object({ email: z.string().email().optional(), phone: z.string().optional(), external_id: z.union([z.string(), z.number()]).optional() }).optional(),
      data:        z.record(z.string(), z.unknown()).optional(),
      label:       z.string().max(128).optional(),
      ttlSec:      z.number().int().positive().optional(),
    },
    handler: async (args) => {
      const out = await service.createLink(args)
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }
    },
  })

  ctx.mcp.tool({
    name: 'shortener.list_links',
    description: 'List recent short links (newest first) with click counts.',
    inputSchema: { limit: z.number().int().positive().max(200).optional() },
    handler: async ({ limit = 50 }) => {
      const rows = await service.listLinks({ limit })
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(rows.map(r => ({
            code: r.code, url: r.url, label: r.label, passport_id: r.passport_id,
            click_count: r.click_count, created_at: r.created_at,
          })), null, 2),
        }],
      }
    },
  })

  ctx.mcp.tool({
    name: 'shortener.link_stats',
    description: 'Inspect one short link by code — its destination, binding, and click/claim stats.',
    inputSchema: { code: z.string() },
    handler: async ({ code }) => {
      const stats = await service.linkStats(code)
      if (!stats) return { isError: true, content: [{ type: 'text', text: `No link ${code}` }] }
      return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] }
    },
  })
}
