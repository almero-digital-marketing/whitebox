// TikTok — client pixel (window.ttq, loaded + init'd externally). tiktok().
// Shares the event_id with the server Events API hit for dedup.

import { cookie, param, removeUndefined, toItems } from 'whitebox-adnetworks/browser'
import { name, events } from './spec.js'

function map(p) {
  const items = toItems(p)
  return removeUndefined({
    value: p.value,
    currency: p.currency,
    contents: items?.map(i => removeUndefined({
      content_id: String(i.id), quantity: i.quantity, price: i.price, content_type: 'product',
    })),
    query: p.search_string,
  })
}

export function tiktok() {
  return {
    name,
    present: () => typeof window !== 'undefined' && window.ttq && typeof window.ttq.track === 'function',
    collect: () => removeUndefined({ ttclid: param('ttclid'), ttp: cookie('_ttp') }),
    fire(kind, event, payload, eventId) {
      window.ttq.track(kind === 'custom' ? event : (events[event] || event), map(payload), { event_id: eventId })
    },
  }
}
