// Tracks whether the user is actively present:
//   - tab is not hidden
//   - window has focus (not Cmd-Tabbed away)
//   - some interaction happened within idleAfterMs
//
// No timers — everything is event-driven + computed-on-read.

const DEFAULT_IDLE_AFTER_MS = 30_000

export default function createActivity({ idleAfterMs = DEFAULT_IDLE_AFTER_MS } = {}) {
  let lastActivity = typeof performance !== 'undefined' ? performance.now() : Date.now()
  let focused = typeof document !== 'undefined' ? document.hasFocus?.() ?? true : true
  let visible = typeof document !== 'undefined' ? document.visibilityState !== 'hidden' : true

  const handlers = []

  function on(handler) {
    handlers.push(handler)
    return () => {
      const i = handlers.indexOf(handler)
      if (i >= 0) handlers.splice(i, 1)
    }
  }

  function notify() {
    const state = { active: isActive() }
    for (const h of handlers) h(state)
  }

  function onActivity() {
    const wasIdle = (performance.now() - lastActivity) >= idleAfterMs
    lastActivity = performance.now()
    if (wasIdle) notify()
  }

  function onVisibility() {
    visible = document.visibilityState !== 'hidden'
    notify()
  }
  function onFocus()   { focused = true;  notify() }
  function onBlur()    { focused = false; notify() }

  function isActive() {
    if (!visible || !focused) return false
    if (typeof performance === 'undefined') return true
    return (performance.now() - lastActivity) < idleAfterMs
  }

  function attach() {
    if (typeof window === 'undefined') return
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    for (const ev of ['mousemove', 'keydown', 'touchstart', 'wheel', 'scroll']) {
      window.addEventListener(ev, onActivity, { passive: true })
    }
  }

  function detach() {
    if (typeof window === 'undefined') return
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('focus', onFocus)
    window.removeEventListener('blur', onBlur)
    for (const ev of ['mousemove', 'keydown', 'touchstart', 'wheel', 'scroll']) {
      window.removeEventListener(ev, onActivity)
    }
  }

  return { attach, detach, isActive, isOpen: isActive, on }
}
