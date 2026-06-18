// Meta Pixel adapter. Assumes `window.fbq` was loaded + init'd ELSEWHERE
// (page / GTM / consent-mode loader) — we only fire events on it. The shared
// eventId goes in `{ eventID }` so Meta dedupes this against the server CAPI hit.

import { resolveEventName } from 'whitebox-adnetworks/taxonomy'
import { removeUndefined, toItems } from './util.js'

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

export const fbq = {
  name: 'meta',   // canonical network name (fires the window.fbq pixel)
  present: () => typeof window !== 'undefined' && typeof window.fbq === 'function',
  fire(kind, name, payload, eventId) {
    const data = map(payload)
    if (kind === 'custom') {
      window.fbq('trackCustom', name, data, { eventID: eventId })
    } else {
      window.fbq('track', resolveEventName({ standard: name }, 'meta'), data, { eventID: eventId })
    }
  },
}
