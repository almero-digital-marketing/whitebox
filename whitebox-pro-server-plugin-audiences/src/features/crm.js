// crm feature — state. Per-passport facts from the context registry (whatever a
// customer's CRM/product pushed via /crm/facts). We never integrate with a
// specific CRM — we read whatever generic facts arrived. See docs/07-crm-integration.md.

let context, store

export function init(deps) { context = deps.context; store = deps.store }

// Pull this passport's CRM facts (a flat key→value bag) and opportunistically
// learn which fact keys exist for discovery (`requires` validation, MCP).
export async function facts(passportId) {
  const collected = await context.collect(passportId, { providers: ['crm'] })
  const bag = flatten(collected?.crm)
  store.recordFactKeys(bag).catch(() => {})   // fire-and-forget discovery cache
  return bag
}

// Which CRM fact keys has the tenant ever sent? (powers requires validation + discovery)
export async function availableKeys() {
  return (await store.listFactKeys()).map(r => ({ key: r.key, type: r.type, sample: r.sample, last_seen: r.last_seen }))
}

// crm providers may return an array of fact records or a single object —
// flatten to one key→value bag, latest-wins.
function flatten(raw) {
  if (!raw) return {}
  if (Array.isArray(raw)) {
    const out = {}
    for (const rec of raw) Object.assign(out, rec?.facts || rec || {})
    return out
  }
  return raw.facts || raw
}
