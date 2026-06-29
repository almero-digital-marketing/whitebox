// Server-side PII masking for the analytics surface. Raw email / phone must NEVER cross the
// HTTP boundary into the analytics app — the people table shows a name when one is known, and
// only a MASKED identity otherwise. Masking happens here, before anything is serialized, so the
// client (and the LLM that powers insights) never receives a raw contact value.

const DOTS = '•••'   // fixed-width mask — hides the value AND its length, and reads cleanly

// maria.ivanova@clinic.test → m•••@clinic.test (first char of the local part; domain kept)
export function maskEmail(v) {
  const s = String(v)
  const at = s.indexOf('@')
  if (at < 1) return maskGeneric(s)
  return `${s[0]}${DOTS}@${s.slice(at + 1)}`
}

// +359881100003 → +359•••03 (country/prefix + last two digits)
export function maskPhone(v) {
  const s = String(v).replace(/[^\d+]/g, '')
  if (s.length < 5) return DOTS
  const head = s.startsWith('+') ? s.slice(0, 4) : s.slice(0, 2)
  return `${head}${DOTS}${s.slice(-2)}`
}

export function maskGeneric(v) {
  const s = String(v)
  return s.length <= 1 ? DOTS : `${s[0]}${DOTS}`
}

export function maskIdentity(type, value) {
  if (value == null) return ''
  if (type === 'email') return maskEmail(value)
  if (type === 'phone') return maskPhone(value)
  return maskGeneric(value)
}

// Fact/identity keys that hold a contact identifier: never rendered as a chart dimension, never
// passed to the LLM raw. (full_name is intentionally NOT here — names are allowed to surface.)
export const CONTACT_KEYS = new Set([
  'email', 'email_address', 'phone', 'phone_number', 'msisdn', 'e164', 'mobile', 'tel',
])
