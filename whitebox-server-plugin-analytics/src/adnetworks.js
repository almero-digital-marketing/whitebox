// Analytics → ad networks: report STANDARD conversion events (purchase, lead,
// view_content, …) via the shared whitebox-adnetworks adapters.
//
// This module is the transport only. The TRIGGER — what conversion fires which
// standard event, and whether the user consented — is the caller's concern:
// call reportStandardEvent() from your conversion handler (a /conversions
// webhook, the conversions plugin, etc.), and gate on marketing consent first.

import { buildAdapters, hashEmail, hashPhone, composeManifest } from 'whitebox-adnetworks'

export function createReporter({ config = {}, passports, logger }) {
  const adapters = buildAdapters(config.networks || {}, { logger })

  async function resolveIds(passportId, signals = {}, extra = {}) {
    const ids = await passports.identities(passportId).catch(() => [])
    const find = t => ids.find(i => i.type === t)?.value || null
    return {
      email_sha256: hashEmail(find('email')),
      phone_sha256: hashPhone(find('phone')),
      external_id: find('external_id') || passportId,
      signals,
      ip: extra.ip, user_agent: extra.user_agent,
    }
  }

  // Report one standard conversion event for a passport to every eligible network.
  //   canonical: { standard:'purchase', event_id, ts?, value?, currency?, content_ids?, items? }
  //   opts:      { signals?, ip?, user_agent? }   — browser ad signals + request context
  // Returns { meta:'accepted'|'rejected'|'skipped'|'error', tiktok:…, google:… }.
  async function reportStandardEvent(passportId, canonical, opts = {}) {
    const ids = await resolveIds(passportId, opts.signals || {}, opts)
    const event = { ts: new Date().toISOString(), ...canonical }
    const out = {}
    for (const a of adapters) {
      if (!a.eligible) { out[a.name] = 'skipped'; continue }
      const res = await a.sendEvent(event, ids).catch(e => ({ status: 'error', error: e.message }))
      out[a.name] = res.status
    }
    return out
  }

  return {
    adapters,
    reportStandardEvent,
    manifest: () => composeManifest(adapters),
    networks: () => adapters.map(a => ({ name: a.name, eligible: a.eligible, transport: a.transport || 'http' })),
  }
}
