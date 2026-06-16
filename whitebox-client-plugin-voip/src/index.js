// VoIP plugin — phone-number tracking.
//
// Opt-in via [data-wb-phone="<tag>"]. When an element with this attribute
// becomes visible, the plugin asks the server for a trackable number from
// that tag's pool, swaps it into the DOM, and emits voip.click when the user
// clicks. Aggressive release: any hint the user isn't actively considering
// the call (tab hide, blur, idle, viewport-leave, maxHold expiry) returns the
// number to the pool.

import createOrchestrator from 'whitebox-client/orchestrator'
import createPhoneTracker from './phone.js'

const DEFAULT_SELECTOR = '[data-wb-phone]'
const DEFAULT_EXCLUDE  = '[data-wb-nophone]'

export default function voipPlugin(localOptions = {}) {
  return {
    name: 'voip',
    install(core) {
      const { transport, http, emitter, queue, logger, config: pluginConfig = {}, deepMerge } = core
      const options = deepMerge ? deepMerge(pluginConfig, localOptions) : { ...pluginConfig, ...localOptions }

      const phone = createPhoneTracker({
        transport,
        http,
        emitter,
        logger,
        onClick: (tag, number) => emitter?.emit?.('voip.click', { tag, number }),
        options,
      })

      // voip owns its own element-selection logic so it doesn't depend on
      // any other plugin. The orchestrator just drives lifecycle (initial
      // scan, MutationObserver, SPA hooks, dedup).
      const selector = options.selector ?? DEFAULT_SELECTOR
      const exclude  = options.excludeSelector ?? DEFAULT_EXCLUDE
      const passes = (el) => !exclude || typeof el.closest !== 'function' || !el.closest(exclude)
      const orchestrator = createOrchestrator({
        tracker: phone,
        find:  (root) => Array.from(root.querySelectorAll?.(selector) || []).filter(passes),
        match: (el)   => typeof el.matches === 'function' && el.matches(selector) && passes(el),
      })

      if (typeof window !== 'undefined') queue(async () => orchestrator.start())

      core.attach('voip', {
        request: phone.request,
        release: phone.release,
        current: phone.current,
        stop:    orchestrator.stop,
      })
    },
  }
}
