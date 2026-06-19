// Google GA4 — server adapter (Measurement Protocol). google({ measurementId, apiSecret }).
// Needs the GA4 client_id (the _ga cookie, collected client-side).

import { name, signals, eventName } from './spec.js'

const MP = 'https://www.google-analytics.com/mp/collect'

export function google(cfg = {}) {
  const eligible = !!(cfg.measurementId && cfg.apiSecret)
  return {
    name,
    signals,
    eligible,
    modes: ['event'],
    transport: 'ga4',

    async sendEvent(canonical, ids) {
      if (!eligible) return { status: 'error', error: 'google/ga4 not configured' }
      const client_id = ids.signals?.ga_client_id
      if (!client_id) return { status: 'rejected', error: 'missing ga_client_id (capture _ga cookie)' }

      const params = { engagement_time_msec: 1, session_id: canonical.event_id }
      if (canonical.value != null) params.value = canonical.value
      if (canonical.currency) params.currency = canonical.currency
      if (canonical.items) params.items = canonical.items
      // GA4 dedupes duplicate purchases sharing a transaction_id (lets the MP hit
      // coexist with a client gtag purchase).
      if (canonical.transaction_id) params.transaction_id = canonical.transaction_id

      const body = {
        client_id,
        ...(ids.external_id ? { user_id: ids.external_id } : {}),
        events: [{ name: eventName(canonical), params }],
        ...(canonical.user_property ? { user_properties: { [canonical.user_property.name]: { value: canonical.user_property.value } } } : {}),
      }
      const res = await fetch(`${MP}?measurement_id=${cfg.measurementId}&api_secret=${cfg.apiSecret}`, {
        method: 'POST', body: JSON.stringify(body),
      })
      if (!res.ok) return { status: 'rejected', error: `mp ${res.status}` }
      return { status: 'accepted', matched_via: ['ga_client_id'] }
    },
  }
}
