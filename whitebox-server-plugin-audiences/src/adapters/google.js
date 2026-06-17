// Google adapter — Mode A via GA4 Measurement Protocol: fire a custom event /
// set a user property; build the audience in GA4 and link it to Google Ads /
// DV360. Needs the GA4 client_id (the `_ga` cookie). See docs/networks/google-ga4.md.

const MP = 'https://www.google-analytics.com/mp/collect'

export function createGoogle(cfg, { logger } = {}) {
  const eligible = !!(cfg?.measurementId && cfg?.apiSecret)
  return {
    name: 'google',
    modes: ['event'],            // membership (Customer Match) is a v2 upgrade
    eligible,
    transport: 'ga4',
    // GA4 ties server events to real browsing via the _ga client_id — required.
    identitySpec: [
      { key: 'ga_client_id', from: 'cookie', name: '_ga', transform: 'ga_cid' },
      { key: 'gclid', from: 'url', name: 'gclid' },
    ],
    acceptedKeys: ['ga_client_id', 'user_id', 'gclid'],

    async sendEvent(canonical, ids) {
      if (!eligible) return { status: 'error', error: 'google/ga4 not configured' }
      const client_id = ids.signals?.ga_client_id
      if (!client_id) return { status: 'rejected', error: 'missing ga_client_id (capture _ga cookie)' }
      const body = {
        client_id,
        ...(ids.external_id ? { user_id: ids.external_id } : {}),
        events: [{
          name: canonical.event,                 // GA4 custom event name
          params: {
            engagement_time_msec: 1,             // ensure it counts toward audiences
            session_id: canonical.event_id,
            ...(canonical.value != null ? { value: canonical.value } : {}),
          },
        }],
        // membership-style segments can also be set as a user property:
        ...(canonical.user_property ? { user_properties: { [canonical.user_property.name]: { value: canonical.user_property.value } } } : {}),
      }
      const url = `${MP}?measurement_id=${cfg.measurementId}&api_secret=${cfg.apiSecret}`
      const res = await fetch(url, { method: 'POST', body: JSON.stringify(body) })
      // MP returns 204 with no body on success; use the /debug endpoint in dev.
      if (!res.ok) { logger?.warn?.({ status: res.status }, 'ga4 mp non-2xx'); return { status: 'rejected', error: `mp ${res.status}` } }
      return { status: 'accepted', matched_via: ['ga_client_id'] }
    },
  }
}
