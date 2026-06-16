// MCP capability registrations for the mail plugin.
//
// Covers the three things an LLM operator most often wants from a mail
// channel: send a message, look up a previously-sent or received message,
// and manage the suppression list (opt-outs). Bulk and tracking are
// intentionally NOT exposed via MCP — bulk is admin-only by design and
// tracking is webhook-driven.

import { z } from 'zod'
import * as suppressions from './suppressions.js'
import * as outbox from './outbox.js'

export function registerMcp(ctx, { db }) {
  if (!ctx.mcp) return

  ctx.mcp.tool({
    name: 'mail.send',
    description: 'Send a transactional email. Either `template` (mikser layout id) or one of `html` / `text` must be provided. Returns the outbox row id and initial status.',
    inputSchema: {
      to:       z.string().email(),
      subject:  z.string().min(1),
      from:     z.string().email().optional(),
      template: z.string().optional(),
      data:     z.record(z.any()).optional(),
      html:     z.string().optional(),
      text:     z.string().optional(),
      idempotency_key: z.string().optional(),
    },
    handler: async (args) => {
      const row = await outbox.create({
        to: args.to,
        subject: args.subject,
        from: args.from,
        template: args.template,
        data: args.data,
        html: args.html,
        text: args.text,
        idempotencyKey: args.idempotency_key,
      })
      await outbox.outboxQueue.add('send', { id: row.id }).catch(() => {})
      return {
        content: [{
          type: 'text',
          text: `Queued mail #${row.id} → ${args.to} (status: ${row.status})`,
        }],
      }
    },
  })

  ctx.mcp.tool({
    name: 'mail.outbox_get',
    description: 'Fetch a single outbox row by id: status, recipient, subject, timestamps, Mailgun id.',
    inputSchema: { id: z.number().int().positive() },
    handler: async ({ id }) => {
      const row = await db('whitebox_mail_outbox').where({ id }).first()
      if (!row) {
        return { isError: true, content: [{ type: 'text', text: `No outbox row #${id}` }] }
      }
      return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] }
    },
  })

  ctx.mcp.tool({
    name: 'mail.inbox_list',
    description: 'List inbound messages (contact-form submissions and Mailgun replies) most-recent-first. Filter by passport, source, or date range.',
    inputSchema: {
      passport_id: z.string().uuid().optional(),
      source:      z.enum(['form', 'inbound']).optional(),
      since:       z.string().datetime().optional(),
      limit:       z.number().int().positive().max(200).optional(),
    },
    handler: async ({ passport_id, source, since, limit = 50 }) => {
      const q = db('whitebox_mail_inbox').orderBy('received_at', 'desc').limit(limit)
      if (passport_id) q.where({ passport_id })
      if (source)      q.where({ source })
      if (since)       q.where('received_at', '>=', new Date(since))
      const rows = await q
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(rows.map(r => ({
            id: r.id, from: r.from, subject: r.subject, source: r.source,
            received_at: r.received_at, passport_id: r.passport_id,
          })), null, 2),
        }],
      }
    },
  })

  ctx.mcp.tool({
    name: 'mail.inbox_get',
    description: 'Fetch a single inbound message by id, including body and attachment URLs.',
    inputSchema: { id: z.number().int().positive() },
    handler: async ({ id }) => {
      const row = await db('whitebox_mail_inbox').where({ id }).first()
      if (!row) {
        return { isError: true, content: [{ type: 'text', text: `No inbox row #${id}` }] }
      }
      return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] }
    },
  })

  ctx.mcp.tool({
    name: 'mail.suppress',
    description: 'Add an email address to the suppression list (user opt-out). Future sends to this address are blocked at preflight.',
    inputSchema: {
      email:  z.string().email(),
      reason: z.string().max(128).optional(),
      notes:  z.string().optional(),
    },
    handler: async ({ email, reason = 'manual', notes = null }) => {
      await suppressions.add({ email, reason, source: 'manual', notes })
      return { content: [{ type: 'text', text: `Suppressed ${email}` }] }
    },
  })

  ctx.mcp.tool({
    name: 'mail.unsuppress',
    description: 'Remove an email address from the suppression list. Use when a user re-opts-in.',
    inputSchema: { email: z.string().email() },
    handler: async ({ email }) => {
      const removed = await suppressions.remove(email)
      return {
        content: [{ type: 'text', text: removed
          ? `Unsuppressed ${email}`
          : `${email} was not on the suppression list` }],
      }
    },
  })

  ctx.mcp.resource({
    name: 'mail-inbox',
    uri: 'whitebox://mail/inbox',
    description: 'Most recent 100 inbound messages. Use the `mail.inbox_get` tool to fetch one by id.',
    mimeType: 'application/json',
    handler: async (uri) => {
      const rows = await db('whitebox_mail_inbox')
        .orderBy('received_at', 'desc')
        .limit(100)
        .select('id', 'from', 'subject', 'source', 'received_at', 'passport_id')
      return {
        contents: [{
          uri: String(uri), mimeType: 'application/json',
          text: JSON.stringify(rows, null, 2),
        }],
      }
    },
  })
}
