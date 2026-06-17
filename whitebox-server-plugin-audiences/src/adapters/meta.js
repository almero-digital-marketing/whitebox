// Meta adapter — Mode A: fire a Conversions API custom event; you build a
// Custom Audience from that event in Ads Manager. See docs/networks/meta.md.

const GRAPH = 'https://graph.facebook.com/v19.0'

export function createMeta(cfg, { logger } = {}) {
  const eligible = !!(cfg?.pixelId && cfg?.accessToken)
  return {
    name: 'meta',
    modes: ['event'],
    eligible,
    // browser signals the client capture shim must collect for Meta
    identitySpec: [
      { key: 'fbp', from: 'cookie', name: '_fbp' },
      { key: 'fbc', from: 'cookie', name: '_fbc', fallback: { from: 'url', name: 'fbclid', transform: 'build_fbc' } },
    ],
    // which keys we send (server resolves hashed PII + IP/UA itself)
    acceptedKeys: ['email', 'phone', 'fbp', 'fbc', 'external_id', 'client_ip_address', 'client_user_agent'],

    // canonical: { event, event_id, ts, value? }  ids: resolved identity (hashed + signals)
    async sendEvent(canonical, ids) {
      if (!eligible) return { status: 'error', error: 'meta not configured' }
      const user_data = pick({
        em: ids.email_sha256, ph: ids.phone_sha256, external_id: ids.external_id,
        fbp: ids.signals?.fbp, fbc: ids.signals?.fbc,
        client_ip_address: ids.ip, client_user_agent: ids.user_agent,
      })
      const body = {
        data: [{
          event_name: canonical.event,
          event_time: Math.floor(new Date(canonical.ts).getTime() / 1000),
          event_id: canonical.event_id,           // dedup with the browser pixel
          action_source: 'website',
          user_data,
          ...(canonical.value != null ? { custom_data: { value: canonical.value } } : {}),
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

const pick = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== ''))
