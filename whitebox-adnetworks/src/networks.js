// Canonical ad-network registry — the single vocabulary shared by the client
// (browser pixels) and server (SST adapters) conversions plugins. One name per
// network, with the browser-pixel global it maps to.
//
// PURE: data + the shared selection logic only — no adapter imports (the server
// adapters pull in node:crypto), so this module is safe to bundle into a browser.

export const NETWORK_NAMES = ['meta', 'google', 'tiktok']

// Canonical name → the browser pixel global it fires through.
export const PIXEL_GLOBAL = { meta: 'fbq', google: 'gtag', tiktok: 'ttq' }

// Declarative collection specs — which browser-only signals each network needs
// for server-side matching, and where to read them from. The single source of
// truth: server adapters expose these as `identitySpec` (→ composeManifest), and
// the client conversions collector reads them to know what to harvest. Add a
// network's cookie here once and BOTH sides pick it up — no hardcoded list.
//   { key, from: 'cookie'|'url', name, transform?, fallback? }
//   transform/fallback.transform are named, client-implemented (e.g. 'ga_cid').
export const SIGNAL_SPECS = {
  meta: [
    { key: 'fbp', from: 'cookie', name: '_fbp' },
    { key: 'fbc', from: 'cookie', name: '_fbc', fallback: { from: 'url', name: 'fbclid', transform: 'build_fbc' } },
  ],
  google: [
    { key: 'ga_client_id', from: 'cookie', name: '_ga', transform: 'ga_cid' },
    { key: 'gclid', from: 'url', name: 'gclid' },
  ],
  tiktok: [
    { key: 'ttclid', from: 'url', name: 'ttclid' },
    { key: 'ttp', from: 'cookie', name: '_ttp' },
  ],
}

// Union of the collection specs for the selected networks (deduped by key).
// This is the client-side equivalent of composeManifest() — same spec data.
export function signalSpecs(networks) {
  const out = []
  const seen = new Set()
  for (const n of selectedNetworks(networks)) {
    for (const spec of SIGNAL_SPECS[n] || []) {
      if (seen.has(spec.key)) continue
      seen.add(spec.key)
      out.push(spec)
    }
  }
  return out
}

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
