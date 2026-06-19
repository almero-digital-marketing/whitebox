// Meta — client pixel (window.fbq, loaded + init'd externally). meta().
// Shares the eventID with the server CAPI hit for dedup.

import { cookie, param, removeUndefined, toItems } from 'whitebox-adnetworks/browser'
import { name, events } from './spec.js'

function map(p) {
  const items = toItems(p)
  return removeUndefined({
    value: p.value,
    currency: p.currency,
    content_ids: items?.map(i => String(i.id)),
    contents: items?.map(i => removeUndefined({ id: String(i.id), quantity: i.quantity ?? 1 })),
    content_type: items ? 'product' : undefined,
    content_name: p.content_name,
    content_category: p.content_category,
    num_items: p.num_items,
    search_string: p.search_string,
  })
}

function buildFbc() {
  const c = cookie('_fbc')
  if (c) return c
  const fbclid = param('fbclid')
  return fbclid ? `fb.1.${Date.now()}.${fbclid}` : null
}

export function meta() {
  return {
    name,
    present: () => typeof window !== 'undefined' && typeof window.fbq === 'function',
    collect: () => removeUndefined({ fbp: cookie('_fbp'), fbc: buildFbc() }),
    fire(kind, event, payload, eventId) {
      const data = map(payload)
      if (kind === 'custom') window.fbq('trackCustom', event, data, { eventID: eventId })
      else window.fbq('track', events[event] || event, data, { eventID: eventId })
    },
  }
}
