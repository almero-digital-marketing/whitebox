// Tracks which opt-in element the mouse pointer is resting on. On desktop a
// paragraph the pointer lingers over is most likely the one being read, so it
// should take focus regardless of scroll order. Inert on touch: pointer events
// whose pointerType isn't "mouse" are ignored, so attended() stays null and the
// tracker falls back to its normal top-to-bottom reading order.

export default function createPointer({ dwellMs = 500, selector = '*' } = {}) {
  let el = null          // tracked element currently under the pointer
  let since = 0          // when the pointer settled on it
  let x = -1, y = -1      // last mouse position (to re-check under a stationary mouse on scroll)

  const now = () => (typeof performance !== 'undefined' ? performance.now() : 0)

  function settle(target) {
    const match = target && target.closest ? target.closest(selector) : null
    if (match !== el) { el = match; since = now() }
  }
  function onMove(e) {
    if (e.pointerType && e.pointerType !== 'mouse') return
    x = e.clientX; y = e.clientY
    settle(e.target)
  }
  function onScroll() {
    // Content moves under a stationary mouse without firing pointermove.
    if (x < 0 || typeof document === 'undefined') return
    settle(document.elementFromPoint(x, y))
  }

  // The element the pointer has rested on for ≥ dwellMs, else null.
  function attended() {
    if (!el) return null
    return now() - since >= dwellMs ? el : null
  }

  function attach() {
    if (typeof window === 'undefined') return
    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('scroll', onScroll, { passive: true })
  }
  function detach() {
    if (typeof window === 'undefined') return
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('scroll', onScroll)
  }

  return { attach, detach, attended }
}
