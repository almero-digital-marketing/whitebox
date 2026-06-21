// Delivery — Mode A. For a qualified match, fire the rule's custom event to each
// target network so the platform builds/keeps the audience. Records an audit row
// and stamps the match's fired map (which drives keep-warm). See docs/02-concepts.md.

let adapters, identity, consent, store, logger

export function init(deps) {
  adapters = deps.adapters
  identity = deps.identity
  consent = deps.consent
  store = deps.store
  logger = deps.logger
}

const byName = name => adapters.find(a => a.name === name)

// Fire all configured networks for one qualified match.
// Returns { fired: {network:bool}, skipped?: reason }.
export async function fireMatch(rule, passportId, verdict, { dryRun = false } = {}) {
  const gate = await consent.allowed(passportId)
  if (!gate.ok) return { skipped: gate.reason, fired: {} }
  const policy = consent.policyAllows(rule, verdict)
  if (!policy.ok) return { skipped: policy.reason, fired: {} }

  const ids = await identity.resolve(passportId)
  const fired = {}
  const day = new Date().toISOString().slice(0, 10)

  for (const [network, target] of Object.entries(rule.delivery || {})) {
    const adapter = byName(network)
    if (!adapter?.eligible) { fired[network] = false; continue }
    // Stable per (rule, passport, day): idempotent within a day, fresh across days
    // so keep-warm re-fires refresh the platform's recency window. Also the dedup
    // key shared with the browser pixel.
    const canonical = { event: target.event, event_id: `${rule.id}:${passportId}:${day}`, ts: new Date().toISOString() }

    if (dryRun) { fired[network] = true; continue }
    try {
      const res = await adapter.sendEvent(canonical, ids)
      await store.insertDelivery({
        rule_id: rule.id, passport_id: passportId, network, event_name: target.event,
        event_id: canonical.event_id, status: res.status, matched_via: JSON.stringify(res.matched_via || []),
        error: res.error || null,
      })
      fired[network] = res.status === 'accepted'
    } catch (err) {
      logger?.warn?.({ err, network }, 'audiences: delivery failed')
      fired[network] = false
    }
  }

  if (!dryRun && Object.values(fired).some(Boolean)) {
    const match = await store.getMatch(rule.id, passportId)
    const firedMap = { ...(match?.fired || {}) }
    const now = new Date().toISOString()
    for (const [n, ok] of Object.entries(fired)) if (ok) firedMap[n] = now
    await store.upsertMatch({ rule_id: rule.id, passport_id: passportId, qualified: true, fired: JSON.stringify(firedMap), last_fired_at: now })
  }
  return { fired }
}
