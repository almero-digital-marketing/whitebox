// Meta — pure, client-safe spec: the canonical→Meta event map and the browser
// signals it matches on. Shared by the server adapter and the client pixel.

export const name = 'meta'
export const pixelGlobal = 'fbq'

export const events = {
  page_view: 'PageView',
  view_content: 'ViewContent',
  search: 'Search',
  add_to_cart: 'AddToCart',
  add_to_wishlist: 'AddToWishlist',
  begin_checkout: 'InitiateCheckout',
  add_payment_info: 'AddPaymentInfo',
  purchase: 'Purchase',
  lead: 'Lead',
  complete_registration: 'CompleteRegistration',
  subscribe: 'Subscribe',
  contact: 'Contact',
}

export const signals = [
  { key: 'fbp', from: 'cookie', name: '_fbp' },
  { key: 'fbc', from: 'cookie', name: '_fbc', fallback: { from: 'url', name: 'fbclid', transform: 'build_fbc' } },
]

// canonical ({ standard } | { event }) → the Meta event name
export const eventName = (canonical) =>
  canonical.standard ? (events[canonical.standard] || canonical.standard) : canonical.event
