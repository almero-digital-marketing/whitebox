// Consent + policy guard. Nothing is forwarded to an ad network unless the
// passport is (a) not suppressed and (b) has the required consent category.
// Plus a sensitive-category guard for AI-derived segments. See docs/08-consent-privacy.md.

import * as store from './store.js'

let passports, config

export function init(deps) {
  passports = deps.passports
  config = deps.config || {}
}

// Gate a passport for delivery. Returns { ok, reason }.
export async function allowed(passportId) {
  if (await store.isSuppressed(passportId)) return { ok: false, reason: 'suppressed' }

  const category = config.requireConsentCategory
  if (category && !(await hasConsent(passportId, category))) {
    return { ok: false, reason: `no ${category} consent` }
  }
  return { ok: true }
}

// Marketing consent per passport. Wire this to however you store consent —
// e.g. a passport flag written at /sessions/resolve from the client consent
// module, or a context provider. Default-deny when a category is required.
async function hasConsent(passportId, category) {
  if (typeof passports.hasConsent === 'function') {
    return passports.hasConsent(passportId, category)
  }
  return false   // safe default: no consent source wired ⇒ do not forward
}

// Sensitive-category guard. A non_sensitive rule must not target inferred
// special-category traits. Returns { ok, reason }. Replace the keyword stub with
// a classifier (or a flag from the AI judge) for production. See docs/08.
export function policyAllows(rule, verdict) {
  if (rule.policy !== 'non_sensitive') return { ok: true }
  const cats = config.sensitiveCategories || []
  const hay = `${verdict.reason || ''} ${JSON.stringify(verdict.evidence || {})}`.toLowerCase()
  const hit = cats.find(c => hay.includes(c))
  return hit ? { ok: false, reason: `sensitive category: ${hit}` } : { ok: true }
}
