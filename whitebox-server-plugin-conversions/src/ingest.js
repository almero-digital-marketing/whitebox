// Ingest — the core of the plugin. Takes a raw event off the wire, validates it
// against the shared schemas, records it as a first-party awareness signal, and
// (consent permitting) fans it out to the ad networks. Idempotent by event_id.
//
// Trust model: the passport_id is the one the client carries (minted at
// /sessions/resolve) — we trust it as the identifier, same as the rest of the
// browser ingress. No session lookup.

import { randomUUID } from 'node:crypto'
import { validateEvent, validateCustom } from 'whitebox-adnetworks/schemas'

import * as store from './store.js'

let awareness, reporter, consentOk, logger

export function init(deps) {
  awareness = deps.awareness
  reporter  = deps.reporter
  consentOk = deps.consentOk            // async (passportId) => boolean
  logger    = deps.logger
}

// A readable, embeddable one-liner so the conversion is queryable via recall
// ("who purchased?", "interest in whitening"). This is what gets embedded.
function describe(name, p) {
  const bits = [`Conversion: ${name.replace(/_/g, ' ')}`]
  if (p.value != null)        bits.push(`${p.value}${p.currency ? ' ' + String(p.currency).toUpperCase() : ''}`)
  if (p.num_items != null)    bits.push(`${p.num_items} item${p.num_items === 1 ? '' : 's'}`)
  if (p.content_name)         bits.push(p.content_name)
  if (p.content_ids?.length)  bits.push(p.content_ids.join(', '))
  if (p.search_string)        bits.push(`"${p.search_string}"`)
  return bits.join(' — ')
}

// Process one raw wire event for a passport.
//   raw: { standard|event, event_id?, ts?, url?, ...payload }
// Returns { event_id, name, status: 'recorded'|'duplicate', networks }.
export async function ingestEvent(passportId, raw = {}, reqCtx = {}) {
  const { standard, event: customName, ts, url, ...payloadIn } = raw

  // Validate against the right schema (unknown keys — standard/ts/url — are
  // already destructured out; the schema strips anything else into nothing).
  let name, kind, clean
  if (standard) {
    name = standard; kind = 'standard'
    clean = validateEvent(standard, payloadIn)        // throws on invalid
  } else if (customName) {
    name = customName; kind = 'custom'
    clean = validateCustom(payloadIn)
  } else {
    throw new Error('conversions: event needs a `standard` or `event` name')
  }

  const eventId = clean.event_id || randomUUID()
  const when = ts ? new Date(ts) : new Date()

  // Idempotency: the browser may double-fire (sendBeacon on unload), and the
  // pixel dedupes on the same id — so do too.
  const existing = await store.seen(eventId)
  if (existing) return { event_id: eventId, name, status: 'duplicate', networks: existing.networks || {} }

  // First-party recording always happens — it's the user's own action. Consent
  // only gates the ad-network fan-out below.
  await awareness.record({
    passport_id: passportId,
    ts:          when,
    channel:     'web',
    direction:   'conversion',
    source:      'conversion',
    content_id:  `conversion:${name}:${eventId}`,
    content_url: url || null,
    text:        describe(name, clean),
    meta:        { kind, event_id: eventId, ...clean },
  }).catch(err => logger?.warn?.({ err }, 'conversions: awareness.record failed'))

  // Fan out to the networks, consent permitting.
  let networks = {}
  if (await consentOk(passportId)) {
    const canonical = {
      [kind === 'standard' ? 'standard' : 'event']: name,
      event_id: eventId,
      ts: when.toISOString(),
      value: clean.value, currency: clean.currency,
      content_ids: clean.content_ids, num_items: clean.num_items,
      transaction_id: clean.transaction_id,
    }
    networks = await reporter.report(passportId, canonical, {
      signals: reqCtx.signals || {}, ip: reqCtx.ip, user_agent: reqCtx.user_agent,
    })
  } else {
    networks = { skipped: 'consent' }
  }

  await store.insert({
    passport_id: passportId,
    event_id:    eventId,
    name, kind,
    value:    clean.value ?? null,
    currency: clean.currency ?? null,
    url:      url || null,
    networks,
    payload:  clean,
  }).catch(err => logger?.warn?.({ err }, 'conversions: audit insert failed'))

  return { event_id: eventId, name, status: 'recorded', networks }
}

// Process a batch; each event is independent — one bad event doesn't sink the
// rest. Returns one result per event (validation failures included).
export async function ingestBatch(passportId, events = [], reqCtx = {}) {
  const results = []
  for (const raw of events) {
    try {
      results.push(await ingestEvent(passportId, raw, reqCtx))
    } catch (err) {
      results.push({ status: 'invalid', error: err.message })
    }
  }
  return results
}
