// MCP capability registration — read-only inspection of the conversion audit
// log. (The conversions themselves are also in awareness, so they're reachable
// via the analytics recall/timeline tools too; this is the per-network view.)

import { z } from 'zod'

export function registerMcp(ctx, { store }) {
  if (!ctx.mcp) return

  ctx.mcp.tool({
    name: 'conversions.list_events',
    description: 'List recent conversion events (newest first) with their per-network delivery status. Optionally scope to one passport.',
    inputSchema: {
      passport_id: z.string().uuid().optional(),
      limit:       z.number().int().positive().max(200).optional(),
    },
    handler: async ({ passport_id, limit = 50 }) => {
      const rows = passport_id
        ? await store.listForPassport(passport_id, { limit })
        : await store.list({ limit })
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(rows.map(r => ({
            event_id: r.event_id, name: r.name, kind: r.kind,
            value: r.value, currency: r.currency,
            networks: r.networks, received_at: r.received_at,
            passport_id: r.passport_id,
          })), null, 2),
        }],
      }
    },
  })

  ctx.mcp.resource({
    name: 'conversions-events',
    uri: 'whitebox://conversions/events',
    description: 'Recent conversion events across the base. Use the conversions.list_events tool to filter by passport.',
    mimeType: 'application/json',
    handler: async (uri) => {
      const rows = await store.list({ limit: 50 })
      return {
        contents: [{
          uri: String(uri), mimeType: 'application/json',
          text: JSON.stringify(rows, null, 2),
        }],
      }
    },
  })
}
