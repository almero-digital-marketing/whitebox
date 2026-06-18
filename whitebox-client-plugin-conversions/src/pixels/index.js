// Browser-pixel dispatch. Fires a canonical event to every selected pixel that
// is actually present on the page (the base snippets are loaded externally — by
// the page / GTM / a consent-mode loader — never by this plugin). A missing
// pixel is a silent no-op; a throwing pixel doesn't sink the others.

import { fbq } from './fbq.js'
import { gtag } from './gtag.js'
import { ttq } from './ttq.js'
import { selectedNetworks } from 'whitebox-adnetworks/networks'

// Keyed by canonical network name (the same vocabulary the server uses), each
// value the pixel impl that fires that network's browser global.
const IMPL = { meta: fbq, google: gtag, tiktok: ttq }

// networks: same shape as the server — a list or { meta: true, … } map, or
// undefined ⇒ all networks (then gated by which pixel globals are present).
export function createPixels({ networks, logger } = {}) {
  const chosen = selectedNetworks(networks).map(n => IMPL[n]).filter(Boolean)

  return {
    // kind: 'standard' | 'custom'. Returns the names actually fired.
    fire(kind, name, payload, eventId) {
      const fired = []
      for (const px of chosen) {
        if (!px.present()) continue
        try {
          px.fire(kind, name, payload, eventId)
          fired.push(px.name)
        } catch (err) {
          logger?.warn?.(`conversions: ${px.name} pixel failed`, err)
        }
      }
      return fired
    },
  }
}
