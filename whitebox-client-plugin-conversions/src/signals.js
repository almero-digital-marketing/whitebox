// Browser ad-signal collection — driven by the shared, declarative specs in
// whitebox-adnetworks (the same `identitySpec`s the server adapters expose and
// composeManifest() unions). NOT a hardcoded cookie list: add a network's signal
// to SIGNAL_SPECS once and it's collected here automatically.
//
// Each spec is { key, from: 'cookie'|'url', name, transform?, fallback? }. We
// read the source, apply the named transform, and fall back to a secondary
// source (e.g. fbclid → _fbc) when the primary is absent. Only signals actually
// present are returned, keyed by `key` (what the server adapters read off
// ids.signals). These exist only in the browser, so we harvest them at
// conversion time and send them in the POST.

import { signalSpecs } from 'whitebox-adnetworks/networks'

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

// Named transforms referenced by the specs (client-side implementations).
const TRANSFORMS = {
  // _ga = "GA1.1.<client_id>" → client_id is the last two dot-segments.
  ga_cid: (raw) => { const p = String(raw).split('.'); return p.length >= 4 ? `${p[2]}.${p[3]}` : null },
  // fbclid URL param → the _fbc value Meta expects.
  build_fbc: (fbclid) => `fb.1.${Date.now()}.${fbclid}`,
}

const readSource = (from, name) => (from === 'url' ? param(name) : cookie(name))

function readSpec(spec) {
  let raw = readSource(spec.from, spec.name)
  if (raw != null) return spec.transform ? TRANSFORMS[spec.transform]?.(raw) ?? null : raw
  // primary absent → try the fallback source (already-transformed).
  if (spec.fallback) {
    const fv = readSource(spec.fallback.from, spec.fallback.name)
    if (fv != null) return spec.fallback.transform ? TRANSFORMS[spec.fallback.transform]?.(fv) ?? null : fv
  }
  return null
}

// Collect the signals the selected networks declare. `networks` is the same
// selection the pixels use (list/map/undefined ⇒ all).
export function collectSignals(networks) {
  const out = {}
  for (const spec of signalSpecs(networks)) {
    const v = readSpec(spec)
    if (v != null) out[spec.key] = v
  }
  return out
}
