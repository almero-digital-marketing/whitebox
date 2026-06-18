// Identity — resolves a passport into the hashed PII + browser signals adapters
// consume, and composes the client-collection manifest. Hashing + manifest
// composition are shared (whitebox-adnetworks); passport resolution is local.
// See docs/06-identity.md.

import { hashEmail, hashPhone, composeManifest } from 'whitebox-adnetworks'
import * as store from './store.js'

let passports

export function init(deps) { passports = deps.passports }

// The client-collection manifest = union of eligible adapters' identitySpecs.
export const manifest = adapters => composeManifest(adapters)

// Save browser-collected signals for a passport (posted by the client shim).
export const saveSignals = (passportId, signals) => store.saveIdentities(passportId, signals)

// Resolve everything an adapter might need to match a passport. Hashed PII comes
// from passport identities (NOT from awareness text, which is redacted).
export async function resolve(passportId) {
  const ids = await passports.identities(passportId).catch(() => [])
  const row = await store.getIdentities(passportId)
  return {
    email_sha256: hashEmail(pickIdentity(ids, 'email')),
    phone_sha256: hashPhone(pickIdentity(ids, 'phone')),
    external_id: pickIdentity(ids, 'external_id') || passportId,
    signals: row?.signals || {},
    // ip / user_agent are request-scoped; attach at the client-capture step if needed.
  }
}

const pickIdentity = (ids, type) => ids.find(i => i.type === type)?.value || null
