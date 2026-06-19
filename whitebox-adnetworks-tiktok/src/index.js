// TikTok — server adapter (Events API). tiktok({ pixelCode, accessToken }).

import { pick } from 'whitebox-adnetworks'
import { name, signals, eventName } from './spec.js'

const EVENTS = 'https://business-api.tiktok.com/open_api/v1.3/event/track/'

export function tiktok(cfg = {}) {
  const eligible = !!(cfg.pixelCode && cfg.accessToken)
  return {
    name,
    signals,
    eligible,
    modes: ['event'],
    transport: 'events',

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
          event: eventName(canonical),
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
      if (json?.code !== 0) return { status: 'rejected', error: json?.message }
      return { status: 'accepted', matched_via: Object.keys(user) }
    },
  }
}
