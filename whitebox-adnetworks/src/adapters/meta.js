// Meta adapter — Conversions API. Fires custom events (audiences) or standard
// events (analytics, mapped via the taxonomy). Mode A.

import { resolveEventName } from '../taxonomy.js'
import { pick } from '../identity.js'
import { SIGNAL_SPECS } from '../networks.js'

const GRAPH = 'https://graph.facebook.com/v19.0'

export function createMeta(cfg, { logger } = {}) {
  const eligible = !!(cfg?.pixelId && cfg?.accessToken)
  return {
    name: 'meta',
    modes: ['event'],
    eligible,
    identitySpec: SIGNAL_SPECS.meta,
    acceptedKeys: ['email', 'phone', 'fbp', 'fbc', 'external_id', 'client_ip_address', 'client_user_agent'],

    // canonical: { event | standard, event_id, ts, value?, currency?, content_ids? }
    async sendEvent(canonical, ids) {
      if (!eligible) return { status: 'error', error: 'meta not configured' }
      const user_data = pick({
        em: ids.email_sha256, ph: ids.phone_sha256, external_id: ids.external_id,
        fbp: ids.signals?.fbp, fbc: ids.signals?.fbc,
        client_ip_address: ids.ip, client_user_agent: ids.user_agent,
      })
      const custom_data = pick({
        value: canonical.value, currency: canonical.currency,
        content_ids: canonical.content_ids, num_items: canonical.num_items,
      })
      const body = {
        data: [{
          event_name: resolveEventName(canonical, 'meta'),
          event_time: Math.floor(new Date(canonical.ts).getTime() / 1000),
          event_id: canonical.event_id,
          action_source: 'website',
          user_data,
          ...(Object.keys(custom_data).length ? { custom_data } : {}),
        }],
        ...(cfg.testEventCode ? { test_event_code: cfg.testEventCode } : {}),
      }
      const res = await fetch(`${GRAPH}/${cfg.pixelId}/events?access_token=${cfg.accessToken}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { logger?.warn?.({ json }, 'meta CAPI rejected'); return { status: 'rejected', error: json?.error?.message } }
      return { status: 'accepted', matched_via: Object.keys(user_data) }
    },
  }
}
