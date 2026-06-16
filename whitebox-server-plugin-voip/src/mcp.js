// MCP capability registrations for the voip plugin.
//
// VoIP is observer-only (we never originate calls), so the MCP surface is
// read-only. Three tools cover what matters: list calls, get a single call
// by vault_id (its stable cross-event identifier), and pull just the
// transcript when that's all the agent needs.

import { z } from 'zod'

import * as calls from './calls.js'

export function registerMcp(ctx, { db }) {
  if (!ctx.mcp) return

  ctx.mcp.tool({
    name: 'voip.list_calls',
    description: 'List recorded calls most-recent-first. Filter by passport, status, tag, or date range.',
    inputSchema: {
      passport_id: z.string().uuid().optional(),
      status:      z.enum(['ringing', 'active', 'ended', 'missed']).optional(),
      tag:         z.string().max(64).optional(),
      since:       z.string().datetime().optional(),
      limit:       z.number().int().positive().max(200).optional(),
    },
    handler: async ({ passport_id, status, tag, since, limit = 50 }) => {
      const q = db('whitebox_voip_calls').orderBy('started_at', 'desc').limit(limit)
      if (passport_id) q.where({ passport_id })
      if (status)      q.where({ status })
      if (tag)         q.where({ tag })
      if (since)       q.where('started_at', '>=', new Date(since))
      const rows = await q.select(
        'vault_id', 'passport_id', 'caller', 'line', 'destination', 'tag',
        'status', 'duration', 'started_at', 'picked_at', 'ended_at',
      )
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] }
    },
  })

  ctx.mcp.tool({
    name: 'voip.get_call',
    description: 'Fetch a single call by its vault_id, including the full transcript and recording URL.',
    inputSchema: { vault_id: z.string().min(1) },
    handler: async ({ vault_id }) => {
      const row = await calls.find(vault_id)
      if (!row) {
        return { isError: true, content: [{ type: 'text', text: `No call with vault_id ${vault_id}` }] }
      }
      return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] }
    },
  })

  ctx.mcp.tool({
    name: 'voip.get_transcript',
    description: 'Fetch only the transcript text of a call. Returns empty string if the call has no transcript (too short, transcription disabled, or still in flight).',
    inputSchema: { vault_id: z.string().min(1) },
    handler: async ({ vault_id }) => {
      const row = await calls.find(vault_id)
      if (!row) {
        return { isError: true, content: [{ type: 'text', text: `No call with vault_id ${vault_id}` }] }
      }
      return { content: [{ type: 'text', text: row.transcription || '' }] }
    },
  })

  ctx.mcp.resource({
    name: 'voip-calls',
    uri: 'whitebox://voip/calls',
    description: 'Most recent 100 calls — caller, line, status, duration, started_at. Use `voip.get_call` to fetch one in full.',
    mimeType: 'application/json',
    handler: async (uri) => {
      const rows = await db('whitebox_voip_calls')
        .orderBy('started_at', 'desc')
        .limit(100)
        .select('vault_id', 'caller', 'line', 'tag', 'status', 'duration',
                'started_at', 'picked_at', 'ended_at', 'passport_id')
      return {
        contents: [{
          uri: String(uri), mimeType: 'application/json',
          text: JSON.stringify(rows, null, 2),
        }],
      }
    },
  })
}
