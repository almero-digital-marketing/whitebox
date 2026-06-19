// Google GA4 — pure spec: canonical→GA4 event map + the signals it needs
// (the _ga client_id is REQUIRED by the Measurement Protocol).

export const name = 'google'
export const pixelGlobal = 'gtag'

export const events = {
  page_view: 'page_view',
  view_content: 'view_item',
  search: 'search',
  add_to_cart: 'add_to_cart',
  add_to_wishlist: 'add_to_wishlist',
  begin_checkout: 'begin_checkout',
  add_payment_info: 'add_payment_info',
  purchase: 'purchase',
  lead: 'generate_lead',
  complete_registration: 'sign_up',
  subscribe: 'subscribe',
  contact: 'contact',
}

export const signals = [
  { key: 'ga_client_id', from: 'cookie', name: '_ga', transform: 'ga_cid' },
  { key: 'gclid', from: 'url', name: 'gclid' },
]

export const eventName = (canonical) =>
  canonical.standard ? (events[canonical.standard] || canonical.standard) : canonical.event
