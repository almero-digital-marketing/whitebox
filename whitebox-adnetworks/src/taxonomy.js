// Standard event taxonomy — a canonical conversion vocabulary mapped to each
// network's standard event name. Analytics fires STANDARD events (purchase,
// lead, …) for conversion tracking; audiences fires CUSTOM events for audience
// building. Both go through the same adapters.

export const STANDARD_EVENTS = {
  //  canonical            meta                    tiktok                ga4
  page_view:             { meta: 'PageView',             tiktok: 'Pageview',          ga4: 'page_view' },
  view_content:          { meta: 'ViewContent',          tiktok: 'ViewContent',       ga4: 'view_item' },
  search:                { meta: 'Search',               tiktok: 'Search',            ga4: 'search' },
  add_to_cart:           { meta: 'AddToCart',            tiktok: 'AddToCart',         ga4: 'add_to_cart' },
  add_to_wishlist:       { meta: 'AddToWishlist',        tiktok: 'AddToWishlist',     ga4: 'add_to_wishlist' },
  begin_checkout:        { meta: 'InitiateCheckout',     tiktok: 'InitiateCheckout',  ga4: 'begin_checkout' },
  add_payment_info:      { meta: 'AddPaymentInfo',       tiktok: 'AddPaymentInfo',    ga4: 'add_payment_info' },
  purchase:              { meta: 'Purchase',             tiktok: 'CompletePayment',   ga4: 'purchase' },
  lead:                  { meta: 'Lead',                 tiktok: 'SubmitForm',        ga4: 'generate_lead' },
  complete_registration: { meta: 'CompleteRegistration', tiktok: 'CompleteRegistration', ga4: 'sign_up' },
  subscribe:             { meta: 'Subscribe',            tiktok: 'Subscribe',         ga4: 'subscribe' },
  contact:               { meta: 'Contact',              tiktok: 'Contact',           ga4: 'contact' },
}

// Resolve the network-specific event name for a canonical event.
//   { standard: 'purchase' }  → 'Purchase' (meta) / 'CompletePayment' (tiktok) / 'purchase' (ga4)
//   { event: 'wb_high_intent' } → 'wb_high_intent' (custom, passthrough)
export function resolveEventName(canonical, network) {
  if (canonical.standard) {
    return STANDARD_EVENTS[canonical.standard]?.[network] || canonical.standard
  }
  return canonical.event
}
