// Zod schemas for the standard-event payloads — the single source of truth for
// "what fields a conversion event carries", shared by the browser client
// (whitebox-client-plugin-conversions, one method per event) and the server
// (validates incoming POST /conversions/events with the SAME schemas).
//
// Deliberately depends only on `zod` + the pure ./taxonomy.js — NOT the adapters
// (those use node:crypto), so this module is safe to bundle into a browser.
//
// Unknown keys are stripped; put anything non-standard in `meta`, which passes
// through untouched. Field vocabulary mirrors what the adapters forward
// (value, currency, content_ids, num_items …) plus the common ad-platform
// semantic params.

import { z } from 'zod'
import { CANONICAL_EVENTS } from './events.js'

const currency = z.string().regex(/^[A-Za-z]{3}$/, 'ISO-4217 3-letter currency code')

const content = z.object({
  id: z.string(),
  quantity: z.number().int().positive().optional(),
  price: z.number().nonnegative().optional(),
})

// Fields shared by every standard event.
const baseShape = {
  event_id: z.string().optional(),                 // auto-generated client-side when omitted
  value: z.number().nonnegative().optional(),
  currency: currency.optional(),
  content_ids: z.array(z.string()).optional(),
  contents: z.array(content).optional(),
  content_type: z.string().optional(),
  content_name: z.string().optional(),
  content_category: z.string().optional(),
  num_items: z.number().int().nonnegative().optional(),
  search_string: z.string().optional(),
  transaction_id: z.string().optional(),   // order id — used for GA4 purchase dedup
  meta: z.record(z.string(), z.unknown()).optional(),
}

export const baseEventSchema = z.object(baseShape)

// purchase is the one standard event where the money fields are mandatory.
const purchaseSchema = z.object({
  ...baseShape,
  value: z.number().nonnegative(),
  currency,
})

// Per-event overrides; everything else uses the shared base.
const OVERRIDES = {
  purchase: purchaseSchema,
}

// One schema per canonical event — keys stay in lock-step with CANONICAL_EVENTS,
// so a new event automatically gets a schema + a client method.
export const EVENT_SCHEMAS = Object.fromEntries(
  CANONICAL_EVENTS.map(name => [name, OVERRIDES[name] || baseEventSchema]),
)

export const CONVERSION_EVENTS = Object.keys(EVENT_SCHEMAS)

function formatIssues(error) {
  return error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
}

// Validate a standard-event payload. Throws a readable Error on invalid input;
// returns the parsed (typed, unknown-keys-stripped) payload on success.
export function validateEvent(standard, payload = {}) {
  const schema = EVENT_SCHEMAS[standard]
  if (!schema) {
    throw new Error(`conversions: unknown standard event "${standard}" (known: ${CONVERSION_EVENTS.join(', ')})`)
  }
  const r = schema.safeParse(payload)
  if (!r.success) throw new Error(`conversions.${standard}: invalid payload — ${formatIssues(r.error)}`)
  return r.data
}

// Custom (non-standard) events: same field vocabulary, any event name.
export function validateCustom(payload = {}) {
  const r = baseEventSchema.safeParse(payload)
  if (!r.success) throw new Error(`conversions.custom: invalid payload — ${formatIssues(r.error)}`)
  return r.data
}
