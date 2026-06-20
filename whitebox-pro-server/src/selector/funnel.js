// Funnels (docs/selector.md §14) — ordered, windowed steps with an anchor that
// ADVANCES each step. The machinery that a single selector can't express: "did A,
// then B within N days *of A*" — an unordered { all: [A, B] } can't tell "in time"
// from "ever."
//
//   funnel = {
//     within?: "30d",                         // optional TOTAL window from entry (step 1)
//     steps: [
//       { select: <selector|name>, name? },              // step 1 — the entry (the anchor)
//       { select: <selector|name>, within: "7d", name? },// ≤ 7d after step 1's match
//       { select: <selector|name>, within: "14d" },      // ≤ 14d after step 2's match
//     ],
//   }
//
// Each step resolves to a `people` cohort scoped to the prior step's survivors;
// `matched_at` (§7) is the per-person event time the windows measure against. A
// windowed step needs a clean event time, so its selector must be deterministic
// (fact); an about/judge step is un-windowed membership only.

const MS = { h: 3600e3, d: 86400e3, w: 604800e3 }
function windowMs(w) {
  const m = /^(\d+)\s*(h|d|w)$/.exec(String(w ?? '').trim())
  if (!m) throw new Error(`funnel: bad window "${w}" (use 7d, 24h, 2w)`)
  return Number(m[1]) * MS[m[2]]
}

function stepSelector(step, named) {
  const sel = step?.select
  if (typeof sel === 'string') {
    if (!named || !(sel in named)) throw new Error(`funnel: unknown named selector "${sel}"`)
    return named[sel]
  }
  if (!sel || typeof sel !== 'object') throw new Error('funnel: each step needs a `select` (a selector or a name)')
  return sel
}

// run(spec, { resolveStep, asOf, named, now }) → { report, steps, gaps }
//   resolveStep(selector, { scope }) → a people result ({ passports: [{ id, matched_at? }] })
//   now — the clock for gap pending/dropped status (defaults to asOf, then real now)
export async function run(spec, { resolveStep, asOf, named, now } = {}) {
  const steps = spec?.steps
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('funnel: needs at least one step')
  if (typeof resolveStep !== 'function') throw new Error('funnel: requires resolveStep')
  const clock = (now ? new Date(now) : asOf ? new Date(asOf) : new Date()).getTime()
  const totalWindow = spec.within ? windowMs(spec.within) : null

  // per-survivor state: { entry: step-1 time, anchor: latest step time } (ms|null)
  let current = new Map()
  const cohorts = []        // cohorts[k] = Set(ids) that reached step k+1
  const stateAfter = []     // stateAfter[k] = Map(id → {entry, anchor}) — for gap status

  for (let k = 0; k < steps.length; k++) {
    const sel = stepSelector(steps[k], named)
    const within = steps[k].within ? windowMs(steps[k].within) : null

    if (k > 0 && current.size === 0) { cohorts[k] = new Set(); stateAfter[k] = new Map(); continue }

    const scope = k === 0 ? undefined : [...current.keys()]
    const res = await resolveStep(sel, { scope })
    const evAt = new Map((res?.passports || []).map(p => [p.id, p.matched_at != null ? new Date(p.matched_at).getTime() : null]))

    const next = new Map()
    if (k === 0) {
      for (const [id, ev] of evAt) next.set(id, { entry: ev, anchor: ev })
    } else {
      for (const [id, ev] of evAt) {
        const prior = current.get(id)
        if (!prior) continue
        if (within != null) {
          // windowed: a clean event strictly after the prior anchor, within the window
          if (ev == null || prior.anchor == null) continue
          if (!(ev > prior.anchor && ev <= prior.anchor + within)) continue
          next.set(id, { entry: prior.entry, anchor: ev })          // anchor advances
        } else {
          // un-windowed membership: advance the anchor only if this step has an event
          next.set(id, { entry: prior.entry, anchor: ev != null ? ev : prior.anchor })
        }
      }
    }
    current = next
    cohorts[k] = new Set(current.keys())
    stateAfter[k] = new Map(current)
  }

  // funnel.within — a fixed velocity gate on completers: total span ≤ within.
  // Unverifiable span (a null anchor/entry from a non-deterministic step) can't be
  // confirmed inside the window, so it's excluded.
  if (totalWindow != null) {
    const last = cohorts.length - 1
    for (const [id, st] of stateAfter[last]) {
      const ok = st.entry != null && st.anchor != null && st.anchor <= st.entry + totalWindow
      if (!ok) { cohorts[last].delete(id); stateAfter[last].delete(id) }
    }
  }

  // drop-off report (the `knowledge` projection of a funnel)
  const entryCount = cohorts[0].size
  const report = cohorts.map((c, k) => ({
    step: k + 1,
    name: steps[k].name ?? null,
    count: c.size,
    stepConversion: k === 0 ? null : (cohorts[k - 1].size ? c.size / cohorts[k - 1].size : 0),
    overall: entryCount ? c.size / entryCount : 0,
  }))

  // per-step cohorts (people) — slot "step:N"
  const stepSlots = {}
  cohorts.forEach((c, k) => { stepSlots[`step:${k + 1}`] = [...c] })

  // gap cohorts (people) — slot "gap:N→M". pending = window still open (act now);
  // dropped = window closed without advancing (win-back).
  const gaps = {}
  for (let k = 0; k < cohorts.length - 1; k++) {
    const advanced = cohorts[k + 1]
    const within = steps[k + 1].within ? windowMs(steps[k + 1].within) : null
    const ids = [], pending = [], dropped = []
    for (const id of cohorts[k]) {
      if (advanced.has(id)) continue
      ids.push(id)
      const st = stateAfter[k].get(id)
      const closed = within != null && st?.anchor != null && clock > st.anchor + within
      ;(closed ? dropped : pending).push(id)
    }
    gaps[`gap:${k + 1}→${k + 2}`] = { ids, pending, dropped }
  }

  return { report, steps: stepSlots, gaps }
}

// Resolve an audience source slot (§14) against a funnel result:
//   "step:2"           → that step's completers
//   "gap:2→3"          → the whole gap cohort
//   "gap:2→3" + status → just the pending / dropped slice
export function slot(result, name, { status } = {}) {
  if (name?.startsWith('step:')) return result.steps[name] || []
  if (name?.startsWith('gap:')) {
    const g = result.gaps[name]
    if (!g) return []
    if (status === 'pending') return g.pending
    if (status === 'dropped') return g.dropped
    return g.ids
  }
  throw new Error(`funnel.slot: unknown slot "${name}"`)
}
