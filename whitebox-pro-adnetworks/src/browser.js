// Client-safe browser helpers used by the network packages' client (pixel)
// modules to read ad cookies/click-ids and shape payloads. Pure — no node deps,
// safe to bundle.

export function cookie(name) {
  if (typeof document === 'undefined') return null
  const esc = name.replace(/([.$?*|{}()[\]\\/+^])/g, '\\$1')
  const m = document.cookie.match(new RegExp('(?:^|; )' + esc + '=([^;]*)'))
  return m ? decodeURIComponent(m[1]) : null
}

export function param(name) {
  if (typeof window === 'undefined') return null
  return new URLSearchParams(window.location.search).get(name)
}

export const removeUndefined = obj => {
  const out = {}
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) out[k] = v
  return out
}

// Normalise the canonical payload's product refs into a single item list.
export const toItems = p => {
  if (p.contents?.length) return p.contents
  if (p.content_ids?.length) return p.content_ids.map(id => ({ id }))
  return undefined
}
