// Identity helpers shared by every consumer: PII hashing (what ad networks match
// on) and manifest composition (what the client must collect). Passport →
// email/phone resolution stays in each plugin — this is the pure part.

import crypto from 'node:crypto'

export const sha256 = v => crypto.createHash('sha256').update(String(v), 'utf8').digest('hex')

// Networks expect normalized, hashed PII.
export const hashEmail = e => e ? sha256(String(e).trim().toLowerCase()) : null
// Phone → E.164 digits (prefix the country code upstream), then hash.
export const hashPhone = p => p ? sha256(String(p).replace(/[^\d]/g, '')) : null

// Union of every eligible network's signal specs → the declarative manifest the
// client capture shim reads. Declarative only (source + named transform), never
// executable code. Accepts composed network descriptors ({ signals }).
export function composeManifest(networks) {
  const seen = new Set()
  const collect = []
  for (const n of networks) {
    if (n.eligible === false) continue
    for (const spec of (n.signals || n.identitySpec || [])) {
      if (seen.has(spec.key)) continue
      seen.add(spec.key)
      collect.push(spec)
    }
  }
  return { collect }
}

export const pick = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== ''))
