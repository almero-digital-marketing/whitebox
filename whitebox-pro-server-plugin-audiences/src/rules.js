// Rule schema + validation. A rule is declarative data; the evaluator and
// adapters consume it. See docs/03-rules.md.

import { z } from 'zod'

// A metric requirement is a deterministic aggregate over awareness exposures.
const MetricReq = z.object({
  content: z.string(),                                  // content_id match (LIKE)
  metric: z.enum(['count', 'distinct_sessions', 'sum_dwell_ms', 'recency_days']),
  gte: z.number().optional(),
  lte: z.number().optional(),
  channel: z.enum(['web', 'mail', 'voip']).optional(),
})

const Delivery = z.object({
  // Mode A only in v1: fire a custom event; the platform builds the audience.
  event: z.string(),
  mode: z.literal('event').default('event'),
}).partial({ mode: true })

export const RuleSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/, 'id must be snake_case'),
  name: z.string().min(1),
  enabled: z.boolean().default(false),

  seed: z.string().min(1),          // text the semantic vector-narrow searches on
  criteria: z.string().min(1),      // natural-language rule the AI judges against
  threshold: z.number().min(0).max(1).default(0.7),
  ttl_days: z.number().int().positive().default(30),
  policy: z.enum(['non_sensitive', 'unrestricted']).default('non_sensitive'),

  // Which feature families the rule depends on. preview validates availability.
  requires: z.object({
    semantic: z.array(z.string()).default([]),
    metric: z.array(MetricReq).default([]),
    crm: z.array(z.string()).default([]),
  }).default({}),

  // One entry per target network: { meta:{event}, tiktok:{event}, google:{event} }
  delivery: z.record(z.enum(['meta', 'tiktok', 'google']), Delivery).default({}),
}).strict()

export function validate(input) {
  const parsed = RuleSchema.safeParse(input)
  if (!parsed.success) {
    const msg = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
    const err = new Error(`invalid rule: ${msg}`)
    err.status = 400
    throw err
  }
  return parsed.data
}

// Serialize jsonb columns for the store; the store expects plain values.
export function toRow(rule, updatedBy) {
  return {
    id: rule.id, name: rule.name, enabled: rule.enabled,
    seed: rule.seed, criteria: rule.criteria, threshold: rule.threshold,
    ttl_days: rule.ttl_days, policy: rule.policy,
    requires: JSON.stringify(rule.requires),
    delivery: JSON.stringify(rule.delivery),
    updated_by: updatedBy || null,
  }
}

export const fromRow = row => row && ({
  ...row,
  requires: typeof row.requires === 'string' ? JSON.parse(row.requires) : row.requires,
  delivery: typeof row.delivery === 'string' ? JSON.parse(row.delivery) : row.delivery,
})
