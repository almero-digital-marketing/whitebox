// Conversions plugin. Each event does two things under one shared event_id:
//   1. fires the browser pixels present on the page (fbq / gtag / ttq), and
//   2. POSTs to whitebox-server (/conversions/events), which records it into
//      awareness and fans out the server-side hits (Meta CAPI / TikTok Events
//      API), deduped against the pixels by that event_id.
// The pixel base snippets are loaded + init'd ELSEWHERE (page / GTM / consent
// loader); this plugin only fires events on already-present globals.
//
// One zod-validated method per standard event (camelCase of the canonical name):
//
//   wb.conversions.purchase({ value, currency, content_ids, num_items })
//   wb.conversions.addToCart({ content_ids, value, currency })
//   wb.conversions.viewContent({ content_ids })
//   wb.conversions.search({ search_string })
//   wb.conversions.pageView() / lead() / subscribe() / contact() / …
//
// Plus two generics:
//   wb.conversions.track(standard, payload)   // same validation, dynamic name
//   wb.conversions.custom(name, payload)       // non-standard event name
//
// Each method validates its payload (throwing on invalid input) BEFORE sending.
// Sends are consent-gated (marketing, by default) since they feed ad networks.

import { CONVERSION_EVENTS, validateEvent, validateCustom } from 'whitebox-adnetworks/schemas'
import { createPixels } from './pixels/index.js'
import { collectSignals } from './signals.js'

const toCamel = s => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase())

function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export default function conversionsPlugin(options = {}) {
  // Conversions feed the ad networks → gate on marketing consent by default.
  // Pass requireConsent:false to send regardless, or change the category.
  // networks: composed client pixels — e.g. [ meta(), tiktok() ] from each
  //   whitebox-adnetworks-<n>/client. Whichever are present on the page fire.
  // sst: also POST to the server (default true) — false ⇒ pixel-only, serverless.
  const { consentCategory = 'marketing', requireConsent = true, networks: networkSelect = [], sst = true } = options

  return {
    name: 'conversions',

    install(core) {
      const { http, queue, consent, logger, getPassportId } = core
      const pixels = createPixels({ networks: networkSelect, logger })

      function consented() {
        if (!requireConsent) return true
        const ok = consent?.has ? consent.has(consentCategory) : true
        if (!ok) logger?.debug?.(`conversions: "${consentCategory}" consent not granted — event skipped`)
        return ok
      }

      // Fire the browser pixels AND (optionally) POST the server hit, all under
      // one shared event_id so the platforms dedupe. Returns { event_id, pixels }
      // (or { skipped } when consent-gated). Validation happened in the caller.
      function emit(canonical) {
        if (!consented()) return Promise.resolve({ skipped: 'consent' })

        const eventId = canonical.event_id || uuid()
        const kind = canonical.standard ? 'standard' : 'custom'
        const name = canonical.standard || canonical.event

        // 1. browser pixels (synchronous, fire-and-forget)
        const firedPixels = pixels.fire(kind, name, canonical, eventId)

        // 2. server SST + first-party awareness
        if (!sst) return Promise.resolve({ event_id: eventId, pixels: firedPixels })

        const event = {
          ...canonical,
          event_id: eventId,
          ts: new Date().toISOString(),
          url: typeof window !== 'undefined' ? window.location.href : null,
        }
        const run = async () => {
          await http.request('/conversions/events', {
            method: 'POST',
            // signals carry the browser-only ad cookies the server APIs match on
            // (GA4 client_id is required; _fbp/_fbc/_ttp improve CAPI matching).
            // Collected per the selected networks' declarative specs (not a
            // hardcoded list) — same vocabulary the server adapters declare.
            body: { passport_id: getPassportId?.(), events: [event], signals: collectSignals(networkSelect) },
          })
          return { event_id: eventId, pixels: firedPixels }
        }
        return queue ? queue(run) : run()
      }

      // Generic: validate against the named standard event, then send.
      function track(standard, payload = {}) {
        const data = validateEvent(standard, payload)
        return emit({ standard, ...data })
      }

      // Custom (non-standard) event name, same field vocabulary.
      function custom(name, payload = {}) {
        if (!name) throw new Error('conversions.custom: `name` is required')
        const data = validateCustom(payload)
        return emit({ event: name, ...data })
      }

      const api = { track, custom }
      // One camelCase method per standard event, each validating its own schema.
      for (const ev of CONVERSION_EVENTS) {
        api[toCamel(ev)] = (payload = {}) => track(ev, payload)
      }

      core.attach('conversions', api)
      logger?.debug?.(`conversions: ${CONVERSION_EVENTS.length} standard-event methods ready`)
    },
  }
}
