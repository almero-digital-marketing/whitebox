// Google GA4 — client pixel (window.gtag, loaded + config'd externally). google().
//
// GA4 has NO pixel↔Measurement-Protocol event_id dedup, so we don't pass an id —
// fire GA4 on ONE side only (client gtag here, OR the server MP adapter, not both
// for the same events; purchases can dedupe server-side via transaction_id).

import { cookie, param, removeUndefined, toItems } from 'whitebox-adnetworks/browser'
import { name, events } from './spec.js'

function map(p) {
  const items = toItems(p)
  return removeUndefined({
    value: p.value,
    currency: p.currency,
    transaction_id: p.transaction_id,
    items: items?.map(i => removeUndefined({ item_id: String(i.id), quantity: i.quantity, price: i.price })),
    search_term: p.search_string,
  })
}

// _ga = "GA1.1.<client_id>" → client_id is the last two dot-segments.
function gaClientId() {
  const ga = cookie('_ga')
  if (!ga) return null
  const parts = String(ga).split('.')
  return parts.length >= 4 ? `${parts[2]}.${parts[3]}` : null
}

export function google() {
  return {
    name,
    present: () => typeof window !== 'undefined' && typeof window.gtag === 'function',
    collect: () => removeUndefined({ ga_client_id: gaClientId(), gclid: param('gclid') }),
    fire(kind, event, payload) {
      window.gtag('event', kind === 'custom' ? event : (events[event] || event), map(payload))
    },
  }
}
