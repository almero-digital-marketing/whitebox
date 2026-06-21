// WhiteBox browser client — CRM plugin.
//
// Reports client-OBSERVED facts about the current passport: things the app
// witnessed in the UI ("completed onboarding step 3", "added 2 items to cart",
// "dismissed the upgrade modal"). These are LOW-TRUST observations, not
// authoritative state — WhiteBox is a semantic memory, not a system of record,
// so they're recorded as evidence tagged source='client' and weighed as
// self-reported. Authoritative state (subscription, plan, CRM stage) must come
// from your backend via the server-side /crm/records webhook — never the browser.
//
// Transport mirrors engagement: socket-primary (identity from the authenticated
// connection), HTTP /crm/observe fallback + sendBeacon on unload. Optionally
// consent-gated (set `consent: 'marketing'` / 'analytics').

const DEFAULT_FLUSH_INTERVAL_MS = 3000
const DEFAULT_BATCH_SIZE = 10

let _seq = 0
const genId = () => `${Date.now().toString(36)}-${(++_seq).toString(36)}`

export default function crmPlugin(localOptions = {}) {
  return {
    name: 'crm',
    install(core) {
      const { transport, http, consent, logger, getPassportId, config: pluginConfig = {}, deepMerge } = core
      const options = deepMerge ? deepMerge(pluginConfig, localOptions) : { ...pluginConfig, ...localOptions }
      const consentCategory = options.consent   // undefined → no gate (app's responsibility)

      const buffer = []
      let flushTimer = null

      function flush() {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
        if (!buffer.length) return
        const observations = buffer.splice(0)
        // Socket-primary: the server takes identity from the connection.
        if (transport?.isConnected?.() && transport.send('crm.observe', { observations })) return
        // HTTP fallback carries the passport explicitly.
        http.request('/crm/observe', { method: 'POST', body: { passport_id: getPassportId?.(), observations } })
          .catch(err => logger?.warn?.('crm observe flush failed', err))
      }

      function scheduleFlush() {
        if (!flushTimer) flushTimer = setTimeout(flush, options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS)
      }

      // observe({ kind, body, id?, ts?, meta? }) — record one client observation.
      function observe(obs = {}) {
        if (!obs.kind || !obs.body) { logger?.warn?.('crm.observe: { kind, body } required'); return }
        if (consentCategory && consent && !consent.has?.(consentCategory)) return   // consent-gated when configured
        buffer.push({ id: obs.id ?? genId(), kind: obs.kind, body: obs.body, ts: obs.ts, meta: obs.meta })
        if (buffer.length >= (options.batchSize ?? DEFAULT_BATCH_SIZE)) flush()
        else scheduleFlush()
      }

      // Final flush on page hide / unload via sendBeacon.
      if (typeof window !== 'undefined') {
        const beaconFlush = () => {
          if (!buffer.length) return
          const observations = buffer.splice(0)
          http.beacon('/crm/observe', { passport_id: getPassportId?.(), observations })
        }
        window.addEventListener('pagehide', beaconFlush)
        window.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'hidden') beaconFlush()
        })
      }

      core.attach('crm', { observe, flush })
    },
  }
}
