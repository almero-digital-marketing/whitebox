// TikTok — pure spec: canonical→TikTok event map + the signals it matches on.

export const name = 'tiktok'
export const pixelGlobal = 'ttq'

export const events = {
  page_view: 'Pageview',
  view_content: 'ViewContent',
  search: 'Search',
  add_to_cart: 'AddToCart',
  add_to_wishlist: 'AddToWishlist',
  begin_checkout: 'InitiateCheckout',
  add_payment_info: 'AddPaymentInfo',
  purchase: 'CompletePayment',
  lead: 'SubmitForm',
  complete_registration: 'CompleteRegistration',
  subscribe: 'Subscribe',
  contact: 'Contact',
}

export const signals = [
  { key: 'ttclid', from: 'url', name: 'ttclid' },
  { key: 'ttp', from: 'cookie', name: '_ttp' },
]

export const eventName = (canonical) =>
  canonical.standard ? (events[canonical.standard] || canonical.standard) : canonical.event
