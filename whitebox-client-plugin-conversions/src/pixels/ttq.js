// TikTok Pixel adapter. Assumes `window.ttq` was loaded + init'd ELSEWHERE.
// The shared eventId goes in `{ event_id }` so TikTok dedupes this against the
// server Events API hit.

import { resolveEventName } from 'whitebox-adnetworks/taxonomy'
import { removeUndefined, toItems } from './util.js'

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

export const ttq = {
  name: 'tiktok',   // canonical network name (fires the window.ttq pixel)
  present: () => typeof window !== 'undefined' && window.ttq && typeof window.ttq.track === 'function',
  fire(kind, name, payload, eventId) {
    const data = map(payload)
    const eventName = kind === 'custom' ? name : resolveEventName({ standard: name }, 'tiktok')
    window.ttq.track(eventName, data, { event_id: eventId })
  },
}
