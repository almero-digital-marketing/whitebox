// Reporter — resolves a passport into the hashed PII + signals the adapters
// consume, then fires one canonical event to every eligible network. Transport
// only; the trigger (which conversion, consent) is the route's concern.
//
// This is the standard-event fan-out that used to live (dormant) in the
// analytics plugin — its natural home is here, next to /conversions/events.

import { buildAdapters, hashEmail, hashPhone, composeManifest } from 'whitebox-adnetworks'

export function createReporter({ networks = {}, passports, logger }) {
  const adapters = buildAdapters(networks, { logger })

  // Hashed PII comes from passport identities (never from awareness text, which
  // is redacted). external_id falls back to the passport id so even an anonymous
  // passport has a stable match key.
  async function resolveIds(passportId, signals = {}, extra = {}) {
    const ids = await passports.identities(passportId).catch(() => [])
    const find = t => ids.find(i => i.type === t)?.value || null
    return {
      email_sha256: hashEmail(find('email')),
      phone_sha256: hashPhone(find('phone')),
      external_id:  find('external_id') || passportId,
      signals,
      ip: extra.ip,
      user_agent: extra.user_agent,
    }
  }

  // Fire one canonical event ({ standard|event, event_id, ts, value?, … }) to
  // every eligible network. Returns { meta: 'accepted'|'rejected'|'skipped'|'error', … }.
  async function report(passportId, canonical, opts = {}) {
    const ids = await resolveIds(passportId, opts.signals || {}, opts)
    const out = {}
    for (const a of adapters) {
      if (!a.eligible) { out[a.name] = 'skipped'; continue }
      const res = await a.sendEvent(canonical, ids).catch(e => ({ status: 'error', error: e.message }))
      out[a.name] = res.status
      if (res.error) logger?.warn?.({ network: a.name, error: res.error }, 'conversions: network rejected event')
    }
    return out
  }

  return {
    adapters,
    report,
    manifest: () => composeManifest(adapters),
    networks: () => adapters.map(a => ({ name: a.name, eligible: a.eligible, transport: a.transport || 'http' })),
  }
}
