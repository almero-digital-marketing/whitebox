// Browser ad-signal collection — the union of each composed network's collect().
// Each network package's /client entry owns its own cookies + transforms (e.g.
// meta reads _fbp/_fbc, google parses _ga → client_id), so this is just a merge.
// These exist only in the browser, so we harvest them at conversion time and
// send them in the POST.

export function collectSignals(networks = []) {
  const out = {}
  for (const net of networks) Object.assign(out, net?.collect?.() || {})
  return out
}
