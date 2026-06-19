// Meta — server adapter (Conversions API). meta({ pixelId, accessToken }).

import { pick } from 'whitebox-adnetworks'
import { name, signals, eventName } from './spec.js'

const GRAPH = 'https://graph.facebook.com/v19.0'

export function meta(cfg = {}) {
  const eligible = !!(cfg.pixelId && cfg.accessToken)
  return {
    name,
    signals,
    eligible,
    modes: ['event'],
    transport: 'capi',

    // canonical: { event | standard, event_id, ts, value?, currency?, content_ids? }
    // ids:       { email_sha256, phone_sha256, external_id, signals{}, ip?, user_agent? }
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
          event_name: eventName(canonical),
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
      if (!res.ok) return { status: 'rejected', error: json?.error?.message }
      return { status: 'accepted', matched_via: Object.keys(user_data) }
    },
  }
}
