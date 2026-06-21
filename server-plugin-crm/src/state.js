// Structured-state adapter over core facts.
//
// CRM used to own a `whitebox_crm_records` table; it no longer does. A record's
// structured state now lands in the core *facts* memory (ctx.facts), so the
// selector queries it directly (`{ fact: { subscription: { eq: "active" } } }`)
// and it time-travels + transitions for free (facts are append-only). The term
// "crm" stays out of core — facts only knows keys, values, sources and entities.
//
// Mapping a record { source, kind, external_id, status, starts_at, data }:
//   · status        → fact  key=kind        value=status        (the primary signal)
//   · each scalar in `data` → fact key=<field> value=<scalar>   (individually queryable)
//   · starts_at     → the fact's observed_at (the event time → matched_at)
//   · source/external_id → the fact's source + entity (`kind:external_id`)
// A status change just appends a new fact; the current view is the latest, the
// history powers temporal queries. Non-scalar `data` fields are skipped (not
// value-queryable); a record with neither status nor scalar data records a bare
// presence fact (key=kind, value=true) so it still exists in the timeline.

let facts
let logger

export function init(deps) {
  facts = deps.facts
  logger = deps.logger
}

const isScalar = v => v != null && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')

// Write one external record as facts. Returns { written } (number of fact rows).
export async function record({ source, kind, external_id, passport_id, status, starts_at, data }) {
  const observed_at = starts_at ? new Date(starts_at) : new Date()
  const entity = `${kind}:${external_id}`
  const common = { passport_id, observed_at, source, entity }

  const writes = []
  if (status != null) writes.push({ key: kind, value: status })
  for (const [k, v] of Object.entries(data || {})) {
    if (isScalar(v)) writes.push({ key: k, value: v })
    else logger?.debug?.({ source, kind, field: k }, 'CRM: skipping non-scalar data field (not value-queryable)')
  }
  if (writes.length === 0) writes.push({ key: kind, value: true })   // bare presence

  let written = 0
  for (const w of writes) {
    try { await facts.record({ ...common, ...w }); written++ }
    catch (err) { logger?.error?.({ err, source, kind, key: w.key }, 'CRM: facts.record failed') }
  }
  return { source, kind, external_id, passport_id, written }
}

// The passport's current structured state → { key: value }. (The facts memory is
// the source of truth; this is just the per-passport read CRM exposes.)
export async function current(passportId) {
  return facts.current(passportId)
}
