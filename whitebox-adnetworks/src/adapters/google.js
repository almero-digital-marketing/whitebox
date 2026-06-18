// Google adapter — GA4 Measurement Protocol. Custom or standard events (mapped
// via taxonomy). Needs the GA4 client_id (the `_ga` cookie).

import { resolveEventName } from '../taxonomy.js'

const MP = 'https://www.google-analytics.com/mp/collect'

export function createGoogle(cfg, { logger } = {}) {
  const eligible = !!(cfg?.measurementId && cfg?.apiSecret)
  return {
    name: 'google',
    modes: ['event'],
    eligible,
    transport: 'ga4',
    identitySpec: [
      { key: 'ga_client_id', from: 'cookie', name: '_ga', transform: 'ga_cid' },
      { key: 'gclid', from: 'url', name: 'gclid' },
    ],
    acceptedKeys: ['ga_client_id', 'user_id', 'gclid'],

    async sendEvent(canonical, ids) {
      if (!eligible) return { status: 'error', error: 'google/ga4 not configured' }
      const client_id = ids.signals?.ga_client_id
      if (!client_id) return { status: 'rejected', error: 'missing ga_client_id (capture _ga cookie)' }
      const params = { engagement_time_msec: 1, session_id: canonical.event_id }
      if (canonical.value != null) params.value = canonical.value
      if (canonical.currency) params.currency = canonical.currency
      if (canonical.items) params.items = canonical.items
      // GA4 dedupes duplicate purchase events sharing a transaction_id — this is
      // what lets the server MP hit coexist with the client gtag purchase.
      if (canonical.transaction_id) params.transaction_id = canonical.transaction_id
      const body = {
        client_id,
        ...(ids.external_id ? { user_id: ids.external_id } : {}),
        events: [{ name: resolveEventName(canonical, 'ga4'), params }],
        ...(canonical.user_property ? { user_properties: { [canonical.user_property.name]: { value: canonical.user_property.value } } } : {}),
      }
      const res = await fetch(`${MP}?measurement_id=${cfg.measurementId}&api_secret=${cfg.apiSecret}`, {
        method: 'POST', body: JSON.stringify(body),
      })
      if (!res.ok) { logger?.warn?.({ status: res.status }, 'ga4 mp non-2xx'); return { status: 'rejected', error: `mp ${res.status}` } }
      return { status: 'accepted', matched_via: ['ga_client_id'] }
    },
  }
}
