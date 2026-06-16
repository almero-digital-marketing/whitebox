import { parsePhoneNumber } from 'libphonenumber-js'

// lines is a tag → number[] map, e.g. { sofia: ['+35921234567'], berlin: ['+49301234567'] }
let lines, country

export function init({ config }) {
  lines = config.voip.lines
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
