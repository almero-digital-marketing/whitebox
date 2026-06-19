// MCP capability registrations for the crm plugin.
//
// Action tools: upsert a record, add a fact (CRM-side write paths that the
// LLM operator might want to trigger — e.g. "log a note that the customer
// called and wants X"). Read tools: list / get individual records. Facts
// flow into awareness and are reachable via the analytics MCP tools, so
// they're not exposed separately here.

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

export function registerMcp(ctx, { records, ingest }) {
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
    name: 'crm.list_records',
    description: 'List CRM records for a passport, most-recent-first by starts_at. Filter by source or kind.',
    inputSchema: {
      passport_id: z.string().uuid(),
      source:      z.string().max(64).optional(),
      kind:        z.string().max(64).optional(),
      limit:       z.number().int().positive().max(500).optional(),
    },
    handler: async ({ passport_id, source, kind, limit = 100 }) => {
      const rows = await records.listForPassport(passport_id, { source, kind, limit })
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(rows.map(r => ({
            source: r.source, kind: r.kind, external_id: r.external_id,
            status: r.status, starts_at: r.starts_at, data: r.data,
          })), null, 2),
        }],
      }
    },
  })

  ctx.mcp.tool({
    name: 'crm.get_record',
    description: 'Fetch one CRM record by its (source, kind, external_id) identity.',
    inputSchema: {
      source:      z.string().min(1).max(64),
      kind:        z.string().min(1).max(64),
      external_id: z.union([z.string(), z.number()]),
    },
    handler: async ({ source, kind, external_id }) => {
      const row = await records.find({ source, kind, external_id: String(external_id) })
      if (!row) {
        return { isError: true, content: [{ type: 'text', text: `No record ${source}/${kind}/${external_id}` }] }
      }
      return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] }
    },
  })

  ctx.mcp.resource({
    name: 'crm-records',
    uri: 'whitebox://crm/records',
    description: 'Use the crm.list_records tool to query records by passport. This resource is an empty placeholder — records are passport-scoped and don\'t have a single list view.',
    mimeType: 'application/json',
    handler: async (uri) => ({
      contents: [{
        uri: String(uri), mimeType: 'application/json',
        text: JSON.stringify({
          note: 'CRM records are passport-scoped. Use the crm.list_records tool with a passport_id.',
        }, null, 2),
      }],
    }),
  })
}
