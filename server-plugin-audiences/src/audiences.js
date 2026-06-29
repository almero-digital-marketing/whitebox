// Audience schema + identity. An audience is a boolean composition of segments —
// the deliverable thing the Audiences module builds and activates. Like a segment
// it stores only the rule (no materialised people); it resolves live by combining
// each member segment's cohort with set algebra. See docs/11-segments-and-audiences.md.

import { z } from 'zod'

// A member references a saved segment by id; `negate` excludes it (the NOT).
const Member = z.object({
  segment: z.string().uuid('member.segment must be a segment id'),
  negate: z.boolean().optional(),
}).strict()

// op = how the (non-negated) members combine: all → AND (intersect), any → OR (union).
// Negated members are always subtracted from the result. At least one positive member
// is required so the result never needs the whole-base universe to define a NOT.
export const AudienceRule = z.object({
  op: z.enum(['all', 'any']).default('all'),
  members: z.array(Member).min(1, 'an audience needs at least one segment'),
}).strict()
  .refine(r => r.members.some(m => !m.negate), 'an audience needs at least one non-negated segment')

export const AudienceInput = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).optional(),
  activation_id: z.string().optional(),
  rule: AudienceRule,
  delivery: z.any().optional(),
  client_side: z.boolean().optional(),                   // expose to the client side (on-site membership)?
  campaigns: z.boolean().optional(),                     // available to the Campaigns module (email & SMS)?
}).strict()

// Default activation id from a name: lowercase, non-alphanumeric → '-', trimmed. The
// user can override it; uniqueness is enforced when saving (service appends -2, -3, …).
export const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'audience'

export function validateAudience(input) {
  const parsed = AudienceInput.safeParse(input)
  if (!parsed.success) {
    const msg = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
    const err = new Error(`invalid audience: ${msg}`)
    err.status = 400
    throw err
  }
  return parsed.data
}

const p = v => (typeof v === 'string' ? JSON.parse(v) : v) ?? undefined
export const fromRow = row => row && {
  id: row.id,
  name: row.name,
  activation_id: row.activation_id,
  rule: p(row.rule),
  delivery: p(row.delivery) ?? undefined,
  client_side: !!row.client_side,
  campaigns: !!row.campaigns,
  created_at: row.created_at,
  updated_at: row.updated_at,
}
