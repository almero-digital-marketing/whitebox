import { z } from 'zod'
import * as outbox from './outbox.js'
import * as suppressions from './suppressions.js'

const TABLE_OUTBOX = 'whitebox_sms_outbox'
const TABLE_INBOX = 'whitebox_sms_inbox'

export function registerMcp(ctx, { db }) {
  if (!ctx.mcp) return

  ctx.mcp.tool({
    name: 'sms.send',
    description: 'Queue an SMS to a phone number (E.164). Provide body or a template id (+ data). Returns the created outbox row.',
    inputSchema: {
      to:          z.string(),
      from:        z.string().optional(),
      body:        z.string().optional(),
      template:    z.string().optional(),
      media:       z.array(z.string().url()).optional(),
      passport_id: z.string().uuid().optional(),
    },
    handler: async ({ to, from, body, template, media, passport_id: passportId }) => {
      if (!body && !template) {
        return { isError: true, content: [{ type: 'text', text: 'body or template is required' }] }
      }
      try {
        const row = await outbox.queueSend({ to, from, body, template, media, passportId })
        return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] }
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: err.message || 'failed to queue sms' }] }
      }
    },
  })

  ctx.mcp.tool({
    name: 'sms.outbox_get',
    description: 'Fetch a single SMS outbox row by id: status, recipient, body, provider, timestamps, segments.',
    inputSchema: { id: z.number().int().positive() },
    handler: async ({ id }) => {
      const row = await db(TABLE_OUTBOX).where({ id }).first()
      if (!row) return { isError: true, content: [{ type: 'text', text: `No outbox row #${id}` }] }
      return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] }
    },
  })

  ctx.mcp.tool({
    name: 'sms.inbox_list',
    description: 'List inbound SMS (replies, STOP/START) most-recent-first. Filter by passport or date range.',
    inputSchema: {
      passport_id: z.string().uuid().optional(),
      since:       z.string().datetime().optional(),
      limit:       z.number().int().positive().max(200).optional(),
    },
    handler: async ({ passport_id: passportId, since, limit = 50 }) => {
      let q = db(TABLE_INBOX).orderBy('created_at', 'desc').limit(limit)
      if (passportId) q = q.where({ passport_id: passportId })
      if (since) q = q.where('created_at', '>=', since)
      const rows = await q
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] }
    },
  })

  ctx.mcp.tool({
    name: 'sms.suppress',
    description: 'Add a phone number to the SMS suppression (opt-out) list.',
    inputSchema: { phone: z.string(), reason: z.enum(['unsubscribed', 'complained', 'manual']).optional() },
    handler: async ({ phone, reason }) => {
      const row = await suppressions.add({ phone, reason: reason || 'manual', source: 'mcp' })
      if (!row) return { isError: true, content: [{ type: 'text', text: 'invalid phone' }] }
      return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] }
    },
  })

  ctx.mcp.tool({
    name: 'sms.unsuppress',
    description: 'Remove a phone number from the SMS suppression list.',
    inputSchema: { phone: z.string() },
    handler: async ({ phone }) => {
      const removed = await suppressions.remove(phone)
      return { content: [{ type: 'text', text: removed ? 'removed' : 'not found' }] }
    },
  })
}
