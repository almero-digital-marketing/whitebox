// Tracks scroll velocity in px/ms. Use isStable() to decide whether the user
// is "settled" enough to be reading rather than skimming.

const DEFAULT_MAX_VELOCITY = 1.0       // px per ms (≈1000 px/s) above which we consider it skimming
const DEFAULT_QUIET_MS = 250           // ms with no scroll movement → consider stable

export default function createVelocity({ maxVelocity = DEFAULT_MAX_VELOCITY, quietMs = DEFAULT_QUIET_MS } = {}) {
  let lastY = typeof window !== 'undefined' ? window.scrollY : 0
  let lastT = typeof performance !== 'undefined' ? performance.now() : 0
  let velocity = 0
  let lastMoveAt = lastT

  function onScroll() {
    const now = performance.now()
    const dt = now - lastT
    if (dt < 8) return
    const dy = window.scrollY - lastY
    velocity = Math.abs(dy) / dt
    lastY = window.scrollY
    lastT = now
    if (Math.abs(dy) > 0) lastMoveAt = now
  }

  // maxOverride lets a caller supply a per-element threshold (e.g. scaled by the
  // element's font size); falls back to the configured maxVelocity.
  function isStable(maxOverride) {
    if (typeof performance === 'undefined') return true
    const now = performance.now()
    if (now - lastMoveAt >= quietMs) return true
    return velocity <= (maxOverride != null ? maxOverride : maxVelocity)
  }

  function attach() {
    if (typeof window === 'undefined') return
    window.addEventListener('scroll', onScroll, { passive: true })
  }

  function detach() {
    if (typeof window === 'undefined') return
    window.removeEventListener('scroll', onScroll)
  }

  return { attach, detach, isStable, isOpen: isStable, getVelocity: () => velocity }
}
