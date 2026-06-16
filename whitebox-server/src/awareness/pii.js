const CC = /\b(?:\d[ -]*?){13,19}\b/g
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{12,30}\b/g

export function redact(text) {
  if (typeof text !== 'string') return text
  return text
    .replace(CC, '[REDACTED-CC]')
    .replace(SSN, '[REDACTED-SSN]')
    .replace(IBAN, '[REDACTED-IBAN]')
}
