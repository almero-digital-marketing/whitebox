import { parsePhoneNumber } from 'libphonenumber-js'

// Internally `lines` is a tag → number[] map, e.g. { sofia: ['+35921234567'] }.
let lines, country

// Config may provide `lines` as that map, OR as the richer array of line
// objects [{ tag, prefix, in: [numbers], out, strategy }] — normalize both to
// the { tag: number[] } map the pool/phonebook use (inbound `in` numbers).
export function normalizeLines(raw) {
  if (Array.isArray(raw)) {
    const map = {}
    for (const l of raw) if (l?.tag) map[l.tag] = l.in || []
    return map
  }
  return raw || {}
}

export function init({ config }) {
  lines = normalizeLines(config.voip.lines)
  country = config.voip.country
}

// Multi-country PBX support: each line declares its inbound numbers, and we
// derive the parsing region from whichever line the raw number belongs to.
// Falls back to the globally configured `country` when no line matches.
export function guessRegionByLineIn(raw) {
  const number = raw.replace(/^0+/, '')
  for (const numbers of Object.values(lines)) {
    for (const inLine of numbers) {
      if (inLine.endsWith(number)) {
        return parsePhoneNumber(inLine).country
      }
    }
  }
  return country
}

// Returns the tag (line name) that owns this E.164 number, or null.
export function findLine(e164) {
  for (const [tag, numbers] of Object.entries(lines)) {
    if (numbers.includes(e164)) return tag
  }
  return null
}

export function toE164(raw, region) {
  return parsePhoneNumber(raw, region).format('E.164')
}

// Pretty-print an E.164 for display. Falls back to the raw input if parsing
// fails — used by the client-facing voip.number payload.
export function format(e164) {
  try {
    const pn = parsePhoneNumber(e164)
    return pn ? pn.formatInternational() : e164
  } catch {
    return e164
  }
}
