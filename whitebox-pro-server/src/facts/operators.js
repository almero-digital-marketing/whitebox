// Pure predicate logic for facts — no DB. `matchValue` evaluates value operators
// against a resolved current/as-of value; `matchTemporal` evaluates change /
// transition operators against a key's ordered history. The store feeds these;
// the selector's `filter.fact` is defined by them. See docs/temporal-facts.md.

const UNIT = { h: 3600e3, d: 86400e3, w: 604800e3 }

// Parse a relative window like "7d", "24h", "2w" → milliseconds.
function ms(window) {
  const m = /^(\d+)\s*(h|d|w)$/.exec(String(window ?? '').trim())
  if (!m) throw new Error(`facts: bad window "${window}" (use e.g. 7d, 24h, 2w)`)
  return Number(m[1]) * UNIT[m[2]]
}

// Numbers compare numerically; ISO-date-ish strings as time; else lexically.
function toTime(v) {
  if (typeof v === 'number') return v
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}
function cmp(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const ta = toTime(a), tb = toTime(b)
  if (ta != null && tb != null) return ta - tb
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
}

const TEMPORAL_OPS = ['changed', 'transition', 'decreased', 'increased']

// A predicate needs the history (not just the current value) iff it uses a
// temporal operator.
export function isTemporal(predicate) {
  return Object.keys(predicate || {}).some(k => TEMPORAL_OPS.includes(k))
}

// Evaluate a value predicate against `value` (which may be undefined when the
// key is absent). Multiple operators in one predicate are AND-ed (e.g. a range
// `{ gte: 200, lte: 400 }`).
export function matchValue(value, predicate, now = new Date()) {
  const nowMs = now.getTime()
  const p = predicate || {}

  if ('present' in p) {
    if (p.present ? value === undefined : value !== undefined) return false
    if (Object.keys(p).length === 1) return true
  }
  if (value === undefined) return false
  const t = toTime(value)

  for (const [op, bound] of Object.entries(p)) {
    let ok
    switch (op) {
      case 'present': continue                                   // already handled
      case 'eq':  ok = value === bound; break
      case 'ne':  ok = value !== bound; break
      case 'in':  ok = Array.isArray(bound) && bound.includes(value); break
      case 'gt':  ok = cmp(value, bound) > 0; break
      case 'gte': ok = cmp(value, bound) >= 0; break
      case 'lt':  ok = cmp(value, bound) < 0; break
      case 'lte': ok = cmp(value, bound) <= 0; break
      // Directional date windows — each states which way time points, so the
      // window is unambiguous without knowing the value.
      case 'next':   ok = t != null && t >= nowMs && t <= nowMs + ms(bound); break    // upcoming, e.g. renews in the next 30d
      case 'last':   ok = t != null && t >= nowMs - ms(bound) && t <= nowMs; break     // recent, e.g. ordered in the last 30d
      case 'before': ok = t != null && t < nowMs - ms(bound); break                    // older than, e.g. last order > 60d ago
      default: throw new Error(`facts: unknown value operator "${op}"`)
    }
    if (!ok) return false
  }
  return true
}

// Evaluate a temporal predicate against `history` (rows oldest-first, each with
// `value` + `observed_at`). `now` bounds the relative windows.
export function matchTemporal(history, predicate, now = new Date()) {
  const nowMs = now.getTime()
  const p = predicate || {}
  const inWin = (r, w) => new Date(r.observed_at).getTime() >= nowMs - ms(w)

  for (const [op, spec] of Object.entries(p)) {
    let ok
    switch (op) {
      case 'changed':
        ok = history.some((r, i) => i > 0 && inWin(r, spec.last) && r.value !== history[i - 1].value)
        break
      case 'transition':
        // A transition needs a prior, different value — the initial observation
        // of a value is not a transition into it.
        ok = history.some((r, i) => {
          if (i === 0 || !inWin(r, spec.last)) return false
          const prev = history[i - 1].value
          if (prev === r.value) return false                        // not a change
          if (spec.to !== undefined && r.value !== spec.to) return false
          if (spec.from !== undefined && prev !== spec.from) return false
          return true
        })
        break
      case 'decreased':
        ok = history.some((r, i) => i > 0 && inWin(r, spec.last) && cmp(r.value, history[i - 1].value) < 0)
        break
      case 'increased':
        ok = history.some((r, i) => i > 0 && inWin(r, spec.last) && cmp(r.value, history[i - 1].value) > 0)
        break
      default: throw new Error(`facts: unknown temporal operator "${op}"`)
    }
    if (!ok) return false
  }
  return true
}
