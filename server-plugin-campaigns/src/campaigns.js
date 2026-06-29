// Campaign schema + row mapping. A campaign is a planned email/SMS send to a set of audiences.
// Mikser upserts the content (keyed by external_id); the UI owns the audience binding + send.

import { z } from 'zod'

export const Channel = z.enum(['email', 'sms'])

// Message content. Email html arrives from Mikser; SMS text is authored in the UI.
const Message = z.object({
  html: z.string().optional(),
  text: z.string().optional(),
  published_at: z.string().optional(),
}).strict().optional()

// What the campaign aims to achieve — drives the AI-built performance report.
const Objective = z.object({
  goals: z.array(z.string()).optional(),   // e.g. ['Bookings', 'Revenue']
  notes: z.string().optional(),            // free-text specific objectives
}).strict().nullish()

// UI-created / edited campaign (POST /campaigns, PATCH /campaigns/:id). All fields optional on
// PATCH; create requires at least a name + channel.
export const CampaignInput = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).optional(),
  channel: Channel.optional(),
  subject: z.string().nullish(),
  scheduled_at: z.string().nullish(),
  message: Message,
  objective: Objective,
  analytics_prompt: z.string().nullish(),
  report_id: z.string().uuid().nullish(),
}).strict()

// Mikser upsert (PUT /campaigns/upsert). external_id is required — it's the idempotency key.
export const UpsertInput = z.object({
  external_id: z.string().min(1),
  name: z.string().min(1),
  channel: Channel,
  subject: z.string().nullish(),
  scheduled_at: z.string().nullish(),
  message: Message,
}).strict()

function parse(schema, input, label) {
  const r = schema.safeParse(input)
  if (!r.success) {
    const msg = r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
    const err = new Error(`invalid ${label}: ${msg}`); err.status = 400; throw err
  }
  return r.data
}
export const validateInput = input => parse(CampaignInput, input, 'campaign')
export const validateUpsert = input => parse(UpsertInput, input, 'campaign upsert')

const p = v => (typeof v === 'string' ? JSON.parse(v) : v) ?? undefined
export const fromRow = row => row && {
  id: row.id,
  external_id: row.external_id ?? undefined,
  source: row.source ?? undefined,
  name: row.name,
  channel: row.channel,
  subject: row.subject ?? undefined,
  scheduled_at: row.scheduled_at ?? undefined,
  status: row.status,
  message: p(row.message) ?? undefined,
  objective: p(row.objective) ?? undefined,
  stats: p(row.stats) ?? undefined,
  analytics_prompt: row.analytics_prompt ?? undefined,
  report_id: row.report_id ?? undefined,
  sent_at: row.sent_at ?? undefined,
  created_at: row.created_at,
  updated_at: row.updated_at,
}

// A campaign is locked once executed — no further edits, attaches, or upserts.
// A campaign locks once it's scheduled (committed to send) — and stays locked through delivery.
export const isLocked = c => c?.status === 'scheduled' || c?.status === 'sent'
