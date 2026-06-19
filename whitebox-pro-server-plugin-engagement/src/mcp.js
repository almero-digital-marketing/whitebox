// MCP capability registrations for the engagement plugin.
//
// Engagement is fundamentally a write channel — the browser client streams
// events in. For an LLM client, the useful surface is read-only: inspect
// the content cache (videos transcribed, images described) and invalidate
// on demand. Per-passport engagement history flows through awareness and
// is exposed via the analytics plugin's MCP tools.

import { z } from 'zod'

export function registerMcp(ctx, { db, content }) {
  if (!ctx.mcp) return

  ctx.mcp.tool({
    name: 'engagement.list_content',
    description: 'List cached engagement-content entries (video transcripts, image descriptions) most-recent-first. Useful to see what whitebox has indexed.',
    inputSchema: {
      kind:  z.enum(['video', 'image']).optional(),
      limit: z.number().int().positive().max(500).optional(),
    },
    handler: async ({ kind, limit = 50 }) => {
      const q = db('whitebox_engagement_content').orderBy('generated_at', 'desc').limit(limit)
      if (kind) q.where({ kind })
      const rows = await q
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(rows.map(r => ({
            url: r.url, kind: r.kind, generated_at: r.generated_at,
            text_chars: r.text?.length ?? 0,
            segments: Array.isArray(r.segments) ? r.segments.length : 0,
          })), null, 2),
        }],
      }
    },
  })

  ctx.mcp.tool({
    name: 'engagement.get_content',
    description: 'Fetch the full cached content entry for a URL: transcript text, segments, and metadata.',
    inputSchema: { url: z.string().url() },
    handler: async ({ url }) => {
      const row = await db('whitebox_engagement_content').where({ url }).first()
      if (!row) {
        return { isError: true, content: [{ type: 'text', text: `No cached content for ${url}` }] }
      }
      return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] }
    },
  })

  ctx.mcp.tool({
    name: 'engagement.invalidate_content',
    description: 'Drop the cached transcript / description for a URL. Next time a visitor engages with this URL, whitebox will regenerate it.',
    inputSchema: { url: z.string().url() },
    handler: async ({ url }) => {
      const deleted = await content.invalidate(url)
      return { content: [{ type: 'text', text: `Invalidated ${deleted} row(s) for ${url}` }] }
    },
  })

  ctx.mcp.resource({
    name: 'engagement-content',
    uri: 'whitebox://engagement/content',
    description: 'List of cached engagement content. Use the `engagement.get_content` tool to fetch a specific URL.',
    mimeType: 'application/json',
    handler: async (uri) => {
      const rows = await db('whitebox_engagement_content')
        .orderBy('generated_at', 'desc')
        .limit(100)
      return {
        contents: [{
          uri: String(uri), mimeType: 'application/json',
          text: JSON.stringify(rows.map(r => ({
            url: r.url, kind: r.kind, generated_at: r.generated_at,
          })), null, 2),
        }],
      }
    },
  })
}
