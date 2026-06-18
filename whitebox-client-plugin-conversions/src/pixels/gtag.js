// GA4 (gtag.js) adapter. Assumes `window.gtag` was loaded + config'd ELSEWHERE.
//
// Note: GA4 does NOT dedupe gtag (client) against the Measurement Protocol
// (server) by a shared event_id the way Meta/TikTok do — so we don't pass one,
// and you should fire GA4 on ONE side only. Default setup: gtag here, and leave
// the server `google` adapter off. (Purchases could be deduped server-side by
// transaction_id, but that's out of scope.)

import { resolveEventName } from 'whitebox-adnetworks/taxonomy'
import { removeUndefined, toItems } from './util.js'

function map(p) {
  const items = toItems(p)
  return removeUndefined({
    value: p.value,
    currency: p.currency,
    transaction_id: p.transaction_id,   // lets the client purchase dedupe vs the server MP hit
    items: items?.map(i => removeUndefined({ item_id: String(i.id), quantity: i.quantity, price: i.price })),
    search_term: p.search_string,
  })
}

export const gtag = {
  name: 'google',   // canonical network name (fires the window.gtag pixel)
  present: () => typeof window !== 'undefined' && typeof window.gtag === 'function',
  fire(kind, name, payload) {
    const data = map(payload)
    const eventName = kind === 'custom' ? name : resolveEventName({ standard: name }, 'ga4')
    window.gtag('event', eventName, data)
  },
}
