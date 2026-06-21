import { parsePhoneNumber } from 'libphonenumber-js'

// Normalize a phone number to E.164 for consistent storage + matching across the
// outbox, suppression and invalid lists. Falls back to a trimmed already-`+`-
// prefixed string when libphonenumber can't parse it (e.g. short codes), and
// null when there's nothing usable.
export function toE164(raw, defaultCountry) {
  if (typeof raw !== 'string') return null
  const t = raw.trim()
  if (!t) return null
  try {
    const pn = parsePhoneNumber(t, defaultCountry)
    if (pn?.isPossible?.()) return pn.format('E.164')
  } catch { /* fall through */ }
  return t.startsWith('+') ? t : null
}

// The E.164 country-calling-code prefix (e.g. "+359") used for provider routing.
export function callingCode(e164) {
  if (typeof e164 !== 'string' || !e164.startsWith('+')) return null
  try {
    const pn = parsePhoneNumber(e164)
    return pn?.countryCallingCode ? `+${pn.countryCallingCode}` : null
  } catch { return null }
}
