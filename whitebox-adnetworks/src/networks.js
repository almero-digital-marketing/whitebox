// Canonical ad-network registry — the single vocabulary shared by the client
// (browser pixels) and server (SST adapters) conversions plugins. One name per
// network, with the browser-pixel global it maps to.
//
// PURE: data + the shared selection logic only — no adapter imports (the server
// adapters pull in node:crypto), so this module is safe to bundle into a browser.

export const NETWORK_NAMES = ['meta', 'google', 'tiktok']

// Canonical name → the browser pixel global it fires through.
export const PIXEL_GLOBAL = { meta: 'fbq', google: 'gtag', tiktok: 'ttq' }

// Normalize a `networks` config into the selected canonical names. Same logic on
// both sides — only the per-network value differs (client: on/off; server: creds).
//   undefined / null                              → all networks (default)
//   ['meta', 'tiktok']                            → those names
//   { meta: true, google: false, tiktok: {...} }  → keys whose value is truthy
//                                                    and not { enabled: false }
export function selectedNetworks(networks) {
  if (networks == null) return [...NETWORK_NAMES]
  if (Array.isArray(networks)) return NETWORK_NAMES.filter(n => networks.includes(n))
  return NETWORK_NAMES.filter(n => {
    const v = networks[n]
    return !!v && v.enabled !== false
  })
}
