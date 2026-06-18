// TikTok adapter — Events API. Custom or standard events (mapped via taxonomy).

import { resolveEventName } from '../taxonomy.js'
import { pick } from '../identity.js'

const EVENTS = 'https://business-api.tiktok.com/open_api/v1.3/event/track/'

export function createTiktok(cfg, { logger } = {}) {
  const eligible = !!(cfg?.pixelCode && cfg?.accessToken)
  return {
    name: 'tiktok',
    modes: ['event'],
    eligible,
    identitySpec: [
      { key: 'ttclid', from: 'url', name: 'ttclid' },
      { key: 'ttp', from: 'cookie', name: '_ttp' },
    ],
    acceptedKeys: ['email', 'phone', 'ttclid', 'ttp', 'ip', 'user_agent'],

    async sendEvent(canonical, ids) {
      if (!eligible) return { status: 'error', error: 'tiktok not configured' }
      const user = pick({
        email: ids.email_sha256, phone: ids.phone_sha256,
        ttclid: ids.signals?.ttclid, ttp: ids.signals?.ttp,
        ip: ids.ip, user_agent: ids.user_agent,
      })
      const properties = pick({
        value: canonical.value, currency: canonical.currency, content_id: canonical.content_ids?.[0],
      })
      const body = {
        event_source: 'web', event_source_id: cfg.pixelCode,
        data: [{
          event: resolveEventName(canonical, 'tiktok'),
          event_time: Math.floor(new Date(canonical.ts).getTime() / 1000),
          event_id: canonical.event_id,
          user,
          ...(Object.keys(properties).length ? { properties } : {}),
        }],
      }
      const res = await fetch(EVENTS, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Access-Token': cfg.accessToken },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => ({}))
      if (json?.code !== 0) { logger?.warn?.({ json }, 'tiktok events rejected'); return { status: 'rejected', error: json?.message } }
      return { status: 'accepted', matched_via: Object.keys(user) }
    },
  }
}
