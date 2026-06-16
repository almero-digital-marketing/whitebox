// Generic engagement state machine. Per element:
//   - intersection threshold met (≥minRatio inside configured rootMargin)
//   - all configured gates open (e.g. activity, optionally velocity)
//
// When all conditions hold, accumulate time. Once accumulated ≥ requiredMs(el),
// emit a `read` event via onRead and stop observing the element.
//
// If the element is removed before reaching the threshold, emit a partial event
// if it accumulated ≥ minPartialRatio × required_ms.
//
// Reading order:
//   - parallel (default): every visible element accumulates simultaneously.
//   - sequential (opt-in): only the topmost visible, not-yet-read element
//     accumulates — modelling top-to-bottom reading. When it fires (or scrolls
//     out of view), focus advances to the next element down. Used for text.
//
// Domain specifics (text vs image vs …) come from injected hooks:
//   - requiredMs(el)            — how much time defines "read"
//   - buildPayload(el, state)   — shape of the emitted event
//   - gates: [{ isOpen }]       — must all be true for time to accumulate

import { elementId } from './scanner.js'

const DEFAULT_OPTS = {
  minRatio: 0.5,
  rootMargin: '-20% 0% -20% 0%',
  tickMs: 250,
  minPartialRatio: 0.5,
  sequential: false,
}

export default function createTracker({
  gates = [],
  requiredMs,
  buildPayload,
  onRead,
  options = {},
} = {}) {
  if (typeof requiredMs !== 'function') throw new Error('tracker: requiredMs(el) is required')
  if (typeof buildPayload !== 'function') throw new Error('tracker: buildPayload(el, state) is required')

  const cfg = { ...DEFAULT_OPTS, ...options }
  const states = new WeakMap()
  const observed = new Set()   // enumerable mirror of what the IO is watching
  const active = new Set()     // elements currently accumulating time
  let io = null
  let tickTimer = null
  let started = false

  function allGatesOpen() {
    for (const g of gates) if (!g.isOpen()) return false
    return true
  }

  function ensureState(el) {
    let s = states.get(el)
    if (s) return s
    s = {
      el,
      id: elementId(el, { idAttribute: cfg.idAttribute }),
      url: typeof window !== 'undefined' ? window.location.href : null,
      required_ms: requiredMs(el),
      accumulated_ms: 0,
      reading: false,
      visible: false,
      last_tick_at: 0,
      fired: false,
    }
    states.set(el, s)
    return s
  }

  function handleIntersect(entries) {
    for (const entry of entries) {
      const s = states.get(entry.target)
      if (!s || s.fired) continue
      s.visible = entry.isIntersecting && entry.intersectionRatio >= cfg.minRatio
    }
    reconcile()
  }

  // Toggle whether an element is accumulating, folding elapsed time in on stop.
  function setReading(s, shouldRead) {
    if (shouldRead && !s.reading) {
      s.reading = true
      s.last_tick_at = performance.now()
      active.add(s.el)
    } else if (!shouldRead && s.reading) {
      accumulate(s)
      s.reading = false
      active.delete(s.el)
    }
  }

  // The topmost (highest on screen) visible, not-yet-fired element. Ties — and
  // the layout-less test environment, where every rect is 0 — fall back to
  // observe order, which is DOM order.
  function pickFocus() {
    let focus = null
    let topY = Infinity
    for (const el of observed) {
      const s = states.get(el)
      if (!s || s.fired || !s.visible) continue
      const y = el.getBoundingClientRect().top
      if (y < topY) { topY = y; focus = s }
    }
    return focus
  }

  // Decide which elements should be accumulating right now.
  function reconcile() {
    const open = allGatesOpen()
    if (cfg.sequential) {
      const focus = open ? pickFocus() : null
      for (const el of observed) {
        const s = states.get(el)
        if (!s || s.fired) continue
        setReading(s, s === focus)
      }
    } else {
      for (const el of observed) {
        const s = states.get(el)
        if (!s || s.fired) continue
        setReading(s, s.visible && open)
      }
    }
  }

  function accumulate(s) {
    const now = performance.now()
    s.accumulated_ms += now - s.last_tick_at
    s.last_tick_at = now
  }

  function tick() {
    reconcile()
    if (!active.size) return
    const now = performance.now()
    let fired = false
    for (const el of [...active]) {
      const s = states.get(el)
      if (!s || s.fired) { active.delete(el); continue }
      const live = now - s.last_tick_at
      if (s.accumulated_ms + live >= s.required_ms) {
        accumulate(s)
        fireRead(s, false)
        fired = true
      }
    }
    // In sequential mode, advance focus to the next element immediately rather
    // than waiting a whole tick after one completes.
    if (fired && cfg.sequential) reconcile()
  }

  function fireRead(s, partial) {
    if (s.fired) return
    s.fired = true
    active.delete(s.el)
    observed.delete(s.el)
    try { io?.unobserve(s.el) } catch { /* ignore */ }
    const payload = buildPayload(s.el, {
      id: s.id,
      url: s.url,
      required_ms: s.required_ms,
      ms_spent: Math.round(s.accumulated_ms),
      partial,
    })
    onRead?.(payload)
  }

  function observe(el) {
    if (!io) return
    if (states.has(el) && states.get(el).fired) return
    ensureState(el)
    observed.add(el)
    io.observe(el)
  }

  function unobserve(el) {
    const s = states.get(el)
    if (!s) return
    if (s.reading) accumulate(s)
    active.delete(el)
    observed.delete(el)
    if (!s.fired && s.accumulated_ms >= s.required_ms * cfg.minPartialRatio) {
      fireRead(s, true)
    } else {
      states.delete(el)
      try { io?.unobserve(el) } catch { /* ignore */ }
    }
  }

  function start() {
    if (started || typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') return
    started = true
    io = new IntersectionObserver(handleIntersect, {
      rootMargin: cfg.rootMargin,
      threshold: [0, cfg.minRatio, 1],
    })
    tickTimer = setInterval(tick, cfg.tickMs)
  }

  function stop() {
    if (!started) return
    started = false
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null }
    try { io?.disconnect() } catch { /* ignore */ }
    io = null
    active.clear()
    observed.clear()
  }

  return { start, stop, observe, unobserve, _states: states, _active: active, _observed: observed }
}
