// Collect the browser ad-network signals the SERVER-side APIs need to match a
// user — these only exist client-side, so we read them here and pass them in the
// /conversions/events POST:
//   • GA4 Measurement Protocol REQUIRES the _ga client_id (rejects without it)
//   • Meta CAPI / TikTok Events API match better with the pixel cookies
//     (_fbp/_fbc, _ttp/ttclid) and click ids.

function cookie(name) {
  if (typeof document === 'undefined') return null
  const esc = name.replace(/([.$?*|{}()[\]\\/+^])/g, '\\$1')
  const m = document.cookie.match(new RegExp('(?:^|; )' + esc + '=([^;]*)'))
  return m ? decodeURIComponent(m[1]) : null
}

function param(name) {
  if (typeof window === 'undefined') return null
  return new URLSearchParams(window.location.search).get(name)
}

// _ga is "GA1.1.<client_id>" where client_id is the last two dot-segments.
function gaClientId() {
  const ga = cookie('_ga')
  if (!ga) return null
  const parts = ga.split('.')
  return parts.length >= 4 ? `${parts[2]}.${parts[3]}` : null
}

// _fbc is derived from the fbclid URL param when the cookie isn't set yet.
function fbc() {
  const c = cookie('_fbc')
  if (c) return c
  const fbclid = param('fbclid')
  return fbclid ? `fb.1.${Date.now()}.${fbclid}` : null
}

// Returns only the signals actually present (no null keys).
export function collectSignals() {
  const all = {
    ga_client_id: gaClientId(),
    fbp:    cookie('_fbp'),
    fbc:    fbc(),
    ttp:    cookie('_ttp'),
    ttclid: cookie('ttclid') || param('ttclid'),
    gclid:  param('gclid'),
  }
  return Object.fromEntries(Object.entries(all).filter(([, v]) => v != null))
}
