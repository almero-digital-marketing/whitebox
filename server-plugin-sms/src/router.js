// Provider router. SMS providers are chosen by destination: a default provider
// plus optional per-prefix overrides (e.g. { '+359': mobica }), longest E.164
// prefix wins. byName() lets webhook handlers select the provider that owns an
// inbound/DLR callback (each provider points its webhooks at /sms/webhooks/:name/*).
export function createRouter({ provider, routes = {} } = {}) {
  if (!provider || typeof provider.send !== 'function') {
    throw new Error('sms(): a default provider is required, e.g. sms({ provider: twilio({ … }) })')
  }

  const entries = Object.entries(routes)
    .filter(([, p]) => p && typeof p.send === 'function')
    .map(([prefix, p]) => [prefix.startsWith('+') ? prefix : `+${prefix}`, p])
    .sort((a, b) => b[0].length - a[0].length)   // longest prefix first

  const byName = {}
  for (const p of [provider, ...entries.map(([, p]) => p)]) {
    if (p?.name) byName[p.name] = p
  }

  return {
    default: provider,
    forNumber(to) {
      if (typeof to === 'string') {
        for (const [prefix, p] of entries) if (to.startsWith(prefix)) return p
      }
      return provider
    },
    byName: (name) => byName[name] || null,
    names: () => Object.keys(byName),
    providers: () => [provider, ...entries.map(([, p]) => p)],
  }
}
