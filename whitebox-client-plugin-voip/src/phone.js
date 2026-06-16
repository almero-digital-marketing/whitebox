// Per-tag phone-number tracker.
//
// Each tag (e.g. 'sales', 'support') is one logical CTA. Multiple DOM elements
// can opt in to the same tag — they all show the same trackable number.
//
// State machine per tag:
//   idle → requesting → assigned → (clicked | releasing) → idle
//
// Aggressive release: any of viewport-leave, tab-hidden, window-blur, idle, or
// maxHold expiry returns the number to the pool. Click is sticky — once the
// user clicks, the number sticks until pagehide or explicit release.

import createActivity from 'whitebox-client/activity'

const DEFAULTS = {
  selector: '[data-wb-phone]',
  excludeSelector: '[data-wb-nophone]',
  tagAttribute: 'data-wb-phone',
  releaseDelayMs: 2_000,
  maxHoldMs: 60_000,
  idleAfterMs: 30_000,
  requestBackoffMs: 5_000,
  minRatio: 0.5,
}

export default function createPhoneTracker({ transport, http, emitter, logger, onClick, options = {} } = {}) {
  const cfg = { ...DEFAULTS, ...options }
  const activity = createActivity({ idleAfterMs: cfg.idleAfterMs })

  // tag → {
  //   tag,
  //   state, number, formatted,
  //   elements: Set<HTMLElement>,
  //   visibleElements: Set<HTMLElement>,
  //   originals: WeakMap<HTMLElement, { href, text }>,
  //   releaseTimer, maxHoldTimer, backoffUntil,
  //   clickHandlers: WeakMap<HTMLElement, fn>,
  // }
  const tags = new Map()

  let io = null
  let activityOff = null
  let started = false

  function tagOf(el) {
    return el.getAttribute(cfg.tagAttribute) || 'default'
  }

  function ensureTag(tag) {
    let s = tags.get(tag)
    if (s) return s
    s = {
      tag,
      state: 'idle',
      number: null,
      formatted: null,
      elements: new Set(),
      visibleElements: new Set(),
      originals: new WeakMap(),
      clickHandlers: new WeakMap(),
      releaseTimer: null,
      maxHoldTimer: null,
      backoffUntil: 0,
    }
    tags.set(tag, s)
    return s
  }

  function rememberOriginal(s, el) {
    if (s.originals.has(el)) return
    s.originals.set(el, {
      href: el.tagName === 'A' ? el.getAttribute('href') : null,
      text: el.textContent,
    })
  }

  function attachClickHandler(s, el) {
    if (el.tagName !== 'A') return
    if (s.clickHandlers.has(el)) return
    const handler = () => {
      if (s.state !== 'assigned' && s.state !== 'clicked') return
      // Fire before browser hands off to tel:
      transport?.send?.('voip.click', { tag: s.tag, number: s.number, ts: Date.now() })
      emitter?.emit?.('voip.click', { tag: s.tag, number: s.number })
      onClick?.(s.tag, s.number)
      // Lock the tag — no more auto-release
      s.state = 'clicked'
      cancelTimers(s)
    }
    s.clickHandlers.set(el, handler)
    el.addEventListener('click', handler)
  }

  function detachClickHandler(s, el) {
    const handler = s.clickHandlers.get(el)
    if (!handler) return
    el.removeEventListener('click', handler)
    s.clickHandlers.delete(el)
  }

  function applyAssignment(s) {
    for (const el of s.elements) {
      rememberOriginal(s, el)
      if (el.tagName === 'A') {
        el.setAttribute('href', `tel:${s.number}`)
      }
      el.textContent = s.formatted || s.number
      el.setAttribute('data-wb-phone-assigned', s.number)
      attachClickHandler(s, el)
    }
  }

  function revertAssignment(s) {
    for (const el of s.elements) {
      const orig = s.originals.get(el)
      if (orig) {
        if (el.tagName === 'A' && orig.href != null) el.setAttribute('href', orig.href)
        el.textContent = orig.text
      }
      el.removeAttribute('data-wb-phone-assigned')
      detachClickHandler(s, el)
    }
  }

  function cancelTimers(s) {
    if (s.releaseTimer) { clearTimeout(s.releaseTimer); s.releaseTimer = null }
    if (s.maxHoldTimer) { clearTimeout(s.maxHoldTimer); s.maxHoldTimer = null }
  }

  function request(tag) {
    const s = ensureTag(tag)
    if (s.state === 'assigned' || s.state === 'clicked' || s.state === 'requesting') return
    if (Date.now() < s.backoffUntil) return
    s.state = 'requesting'
    transport?.send?.('voip.pick', { tag })
  }

  function release(tag, { silent = false } = {}) {
    const s = tags.get(tag)
    if (!s || s.state === 'idle') return
    cancelTimers(s)
    if (s.state === 'assigned' || s.state === 'clicked' || s.state === 'requesting') {
      if (!silent) transport?.send?.('voip.hang', { tag })
    }
    if (s.number) revertAssignment(s)
    s.state = 'idle'
    s.number = null
    s.formatted = null
  }

  function releaseViaBeacon(tag) {
    // For pagehide — emit hang via HTTP beacon as a fallback since WS frames
    // may not flush. The server also has its own timeout, this is just faster.
    if (!http?.beacon) return
    http.beacon('/voip/hang', { tag })
  }

  function scheduleReleaseAfterViewportLeave(s) {
    if (s.state === 'clicked') return
    if (s.visibleElements.size > 0) return
    if (s.releaseTimer) clearTimeout(s.releaseTimer)
    s.releaseTimer = setTimeout(() => {
      if (s.visibleElements.size === 0 && s.state !== 'clicked') release(s.tag)
    }, cfg.releaseDelayMs)
  }

  // -------- transport message handlers --------

  function onNumberAssigned({ tag, number, formatted }) {
    const s = ensureTag(tag)
    if (s.state !== 'requesting' || !number) return
    s.state = 'assigned'
    s.number = number
    s.formatted = formatted || number
    applyAssignment(s)

    if (s.maxHoldTimer) clearTimeout(s.maxHoldTimer)
    s.maxHoldTimer = setTimeout(() => {
      if (s.state === 'clicked') return
      logger?.debug?.('voip: maxHoldMs elapsed for %s', tag)
      release(tag)
    }, cfg.maxHoldMs)

    emitter?.emit?.('voip.number', { tag, number, formatted: s.formatted })
  }

  function onUnavailable({ tag }) {
    const s = ensureTag(tag)
    s.state = 'idle'
    s.backoffUntil = Date.now() + cfg.requestBackoffMs
    emitter?.emit?.('voip.unavailable', { tag })
  }

  function onRing(payload) {
    emitter?.emit?.('voip.ring', payload)
  }

  // -------- IntersectionObserver --------

  function handleIntersect(entries) {
    for (const entry of entries) {
      const el = entry.target
      const tag = tagOf(el)
      const s = ensureTag(tag)
      const visible = entry.isIntersecting && entry.intersectionRatio >= cfg.minRatio
      if (visible) {
        s.visibleElements.add(el)
        if (s.releaseTimer) { clearTimeout(s.releaseTimer); s.releaseTimer = null }
        if (s.state === 'idle' && activity.isOpen()) request(tag)
      } else {
        s.visibleElements.delete(el)
        if (s.visibleElements.size === 0) scheduleReleaseAfterViewportLeave(s)
      }
    }
  }

  // -------- activity / visibility / blur handlers --------

  function releaseAll({ silent = false, viaBeacon = false } = {}) {
    for (const tag of [...tags.keys()]) {
      const s = tags.get(tag)
      if (s && (s.state === 'assigned' || s.state === 'clicked' || s.state === 'requesting')) {
        if (viaBeacon) releaseViaBeacon(tag)
        release(tag, { silent })
      }
    }
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'hidden') releaseAll()
  }
  function onBlur() { releaseAll() }
  function onPageHide() { releaseAll({ viaBeacon: true }) }

  function onActivityChange({ active }) {
    if (!active) releaseAll()
  }

  // -------- public tracker contract --------

  function observe(el) {
    if (!io) return
    const tag = tagOf(el)
    const s = ensureTag(tag)
    s.elements.add(el)
    rememberOriginal(s, el)
    if (s.state === 'assigned' || s.state === 'clicked') {
      // New element joining an already-assigned tag — apply immediately
      if (el.tagName === 'A') el.setAttribute('href', `tel:${s.number}`)
      el.textContent = s.formatted || s.number
      el.setAttribute('data-wb-phone-assigned', s.number)
      attachClickHandler(s, el)
    }
    io.observe(el)
  }

  function unobserve(el) {
    const tag = tagOf(el)
    const s = tags.get(tag)
    if (!s) return
    s.elements.delete(el)
    s.visibleElements.delete(el)
    detachClickHandler(s, el)
    try { io?.unobserve(el) } catch { /* ignore */ }
    // Revert this element (others in the tag stay)
    const orig = s.originals.get(el)
    if (orig) {
      if (el.tagName === 'A' && orig.href != null) el.setAttribute('href', orig.href)
      el.textContent = orig.text
      el.removeAttribute('data-wb-phone-assigned')
      s.originals.delete(el)
    }
    if (s.elements.size === 0) release(tag)
  }

  function start() {
    if (started || typeof window === 'undefined') return
    started = true

    activity.attach()
    activityOff = activity.on(onActivityChange)

    io = new IntersectionObserver(handleIntersect, {
      threshold: [0, cfg.minRatio, 1],
    })

    transport?.on?.('voip.number', onNumberAssigned)
    transport?.on?.('voip.unavailable', onUnavailable)
    transport?.on?.('voip.ring', onRing)

    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('blur', onBlur)
    window.addEventListener('pagehide', onPageHide)
  }

  function stop() {
    if (!started) return
    started = false

    releaseAll()

    transport?.off?.('voip.number', onNumberAssigned)
    transport?.off?.('voip.unavailable', onUnavailable)
    transport?.off?.('voip.ring', onRing)

    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('blur', onBlur)
    window.removeEventListener('pagehide', onPageHide)

    try { io?.disconnect() } catch { /* ignore */ }
    io = null

    activityOff?.()
    activityOff = null
    activity.detach()

    tags.clear()
  }

  // Public manual API
  function current(tag) {
    const s = tags.get(tag)
    if (!s || s.state === 'idle') return null
    return { tag, number: s.number, formatted: s.formatted, state: s.state }
  }

  return { start, stop, observe, unobserve, request, release, current, _tags: tags }
}
