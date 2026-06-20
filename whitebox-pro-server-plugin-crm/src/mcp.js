// MCP capability registrations for the crm plugin.
//
// Action tools: upsert a record (→ core facts), add a note (→ awareness). Read
// tool: a passport's current structured state (read back from facts). Notes flow
// into awareness and are reachable via the analytics MCP tools; structured state
// is core facts, queryable via the core whitebox.query tool.

import { z } from 'zod'

// Shared customer block — matches the HTTP webhook schema.
const customerShape = {
  email:       z.string().email().optional(),
  phone:       z.string().optional(),
  country:     z.string().length(2).optional(),
  external_id: z.union([z.string(), z.number()]).optional(),
}

function dropReason(result) {
  if (result.reason === 'no_identity')
    return `Dropped: no identifying info (email / phone / external_id) in customer block.`
  if (result.reason === 'empty_payload')
    return `Dropped: nothing to ingest.`
  return null
}

export function registerMcp(ctx, { state, ingest }) {
  if (!ctx.mcp) return

  ctx.mcp.tool({
    name: 'crm.upsert_record',
    description: 'Upsert a single CRM record (reservation, subscription, deal, ticket, …) keyed by (source, kind, external_id). The customer must carry at least one of email / phone / external_id so we can attach the record to a passport.',
    inputSchema: {
      source:      z.string().min(1).max(64),
      customer:    z.object(customerShape),
      kind:        z.string().min(1).max(64),
      external_id: z.union([z.string(), z.number()]),
      status:      z.string().max(64).optional().nullable(),
      starts_at:   z.string().datetime().optional().nullable(),
      data:        z.record(z.any()).optional(),
    },
    handler: async ({ source, customer, kind, external_id, status, starts_at, data }) => {
      const result = await ingest.ingestRecords({
        source,
        customer,
        records: [{ kind, external_id, status, starts_at, data }],
      })
      const dropped = dropReason(result)
      if (dropped) return { isError: true, content: [{ type: 'text', text: dropped }] }
      return {
        content: [{
          type: 'text',
          text: `Upserted ${kind}/${external_id} (passport ${result.passport_id}${result.passport_created ? ', new' : ''})`,
        }],
      }
    },
  })

  ctx.mcp.tool({
    name: 'crm.add_fact',
    description: 'Add a single free-form fact about a customer (note, tag, call summary, allergy, …). Optionally refs a record. Lands in awareness with channel="crm", direction="observation" — searchable via whitebox.recall and visible in whitebox.timeline.',
    inputSchema: {
      source:   z.string().min(1).max(64),
      customer: z.object(customerShape),
      id:       z.union([z.string(), z.number()]),
      kind:     z.string().min(1).max(64),                       // 'note' | 'tag' | 'call_summary' | …
      body:     z.string().min(1),
      ts:       z.string().datetime().optional(),
      ref:      z.object({
        kind:        z.string().min(1).max(64),
        external_id: z.union([z.string(), z.number()]),
      }).optional().nullable(),
    },
    handler: async ({ source, customer, id, kind, body, ts, ref }) => {
      const result = await ingest.ingestFacts({
        source,
        customer,
        facts: [{ id, kind, body, ts, ref }],
      })
      const dropped = dropReason(result)
      if (dropped) return { isError: true, content: [{ type: 'text', text: dropped }] }
      return {
        content: [{
          type: 'text',
          text: `Recorded ${kind} fact ${id} (passport ${result.passport_id}${result.passport_created ? ', new' : ''})`,
        }],
      }
    },
  })

  ctx.mcp.tool({
    name: 'crm.get_state',
    description: 'Get a customer\'s current structured state — the key→value facts CRM records have written for this passport (e.g. { subscription: "active", plan_tier: "pro" }). For history, transitions or cross-customer queries, use the core whitebox.query tool (these are core facts).',
    inputSchema: {
      passport_id: z.string().uuid(),
    },
    handler: async ({ passport_id }) => {
      const current = await state.current(passport_id)
      return { content: [{ type: 'text', text: JSON.stringify(current, null, 2) }] }
    },
  })
}
