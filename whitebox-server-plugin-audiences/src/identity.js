// Identity — composes the client-collection manifest from the adapters, and
// resolves a passport into the hashed PII + browser signals adapters consume.
// See docs/06-identity.md.

import crypto from 'node:crypto'
import * as store from './store.js'

let passports

export function init(deps) { passports = deps.passports }

// Union of every eligible adapter's identitySpec → the declarative manifest the
// client capture shim reads (never executable code — source + named transform).
export function manifest(adapters) {
  const seen = new Set()
  const collect = []
  for (const a of adapters) {
    if (!a.eligible) continue
    for (const spec of a.identitySpec || []) {
      if (seen.has(spec.key)) continue
      seen.add(spec.key)
      collect.push(spec)
    }
  }
  return { collect }
}

// Save browser-collected signals for a passport (posted by the client shim).
export const saveSignals = (passportId, signals) => store.saveIdentities(passportId, signals)

// Resolve everything an adapter might need to match a passport. Hashed PII comes
// from passport identities (NOT from awareness text, which is redacted).
export async function resolve(passportId) {
  const ids = await passports.identities(passportId).catch(() => [])
  const email = pickIdentity(ids, 'email')
  const phone = pickIdentity(ids, 'phone')
  const row = await store.getIdentities(passportId)
  return {
    email_sha256: email ? sha256(normalizeEmail(email)) : null,
    phone_sha256: phone ? sha256(normalizePhone(phone)) : null,
    external_id: pickIdentity(ids, 'external_id') || passportId,
    signals: row?.signals || {},
    // ip / user_agent are request-scoped; attach at the client-capture step if needed.
  }
}

const pickIdentity = (ids, type) => ids.find(i => i.type === type)?.value || null
const sha256 = v => crypto.createHash('sha256').update(v, 'utf8').digest('hex')
const normalizeEmail = e => String(e).trim().toLowerCase()
const normalizePhone = p => String(p).replace(/[^\d]/g, '') // E.164 digits; prefix country code upstream
