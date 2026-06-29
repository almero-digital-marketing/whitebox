// Segment schema + identity. A segment is a chart-derived dynamic sub-query: a
// saved selector source (a `select` selector OR a `funnel` + slot) with NO delivery.
// Same source grammar as a rule (reused from rules.js), minus lifecycle/delivery.
// See docs/11-segments-and-audiences.md.

import { z } from 'zod'
import crypto from 'node:crypto'
import { Selector, Funnel, SLOT_RE } from './rules.js'

// A segment's source is EITHER a `select` selector OR a `funnel` + `slot` cohort —
// exactly one, mirroring a rule's source (rules.js) but without delivery/lifecycle.
export const SegmentSource = z.object({
  select: Selector.optional(),
  funnel: Funnel.optional(),
  slot:   z.string().regex(SLOT_RE, 'slot must be "step:N" or "gap:N→M"').optional(),
  status: z.enum(['pending', 'dropped']).optional(),
}).strict()
  .refine(s => (s.select != null) !== (s.funnel != null), 'a segment needs exactly one source: `select` or `funnel`')
  .refine(s => s.funnel == null || s.slot != null, 'a `funnel` source needs a `slot` (e.g. "step:2" or "gap:2→3")')
  .refine(s => s.status == null || (s.slot != null && s.slot.startsWith('gap:')), '`status` only applies to a gap slot')

export function validateSource(input) {
  const parsed = SegmentSource.safeParse(input)
  if (!parsed.success) {
    const msg = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
    const err = new Error(`invalid segment source: ${msg}`)
    err.status = 400
    throw err
  }
  return parsed.data
}

// Deterministic identity of a source — stable across key order — so the same slice
// selected twice dedups to one segment (the AI name is cosmetic on top of this).
const stable = o => o === null || typeof o !== 'object' ? JSON.stringify(o)
  : Array.isArray(o) ? '[' + o.map(stable).join(',') + ']'
    : '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + stable(o[k])).join(',') + '}'
export const predicateKey = source => crypto.createHash('sha256').update(stable(source)).digest('hex')

const p = v => (typeof v === 'string' ? JSON.parse(v) : v) ?? undefined
export const fromRow = row => row && {
  id: row.id,
  name: row.name,
  source: p(row.source),
  predicate_key: row.predicate_key,
  origin: p(row.origin) ?? undefined,
  created_at: row.created_at,
  updated_at: row.updated_at,
}
