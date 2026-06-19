// Generic DOM-lifecycle wrapper.
//
// Knows nothing about CSS selectors, attributes, or text content. The caller
// supplies two callbacks:
//
//   find(root)  → iterable of elements within `root` that should be tracked
//   match(el)   → boolean, called for individual elements added via
//                 MutationObserver after start(); decides whether the new
//                 node belongs to this tracker. Optional; defaults to () => true.
//
// The orchestrator handles:
//   - initial scan after DOMContentLoaded
//   - MutationObserver for adds / removes (subtree)
//   - SPA navigation re-scan on history.pushState / history.replaceState / popstate
//   - WeakSet-based dedup (an element is only observed once even if it appears
//     in the initial scan AND is later flagged by the mutation observer)
//
// `tracker` is the consumer's domain logic — anything exposing:
//   { start?, stop?, observe(el), unobserve(el) }

export default function createOrchestrator({ tracker, find, match } = {}) {
  if (!tracker)             throw new Error('orchestrator: tracker is required')
  if (typeof find !== 'function')  throw new Error('orchestrator: find(root) function is required')
  const isMatch = typeof match === 'function' ? match : () => true

  let mo = null
  let started = false
  let historyHook = null
  const seen = new WeakSet()   // elements currently observed — prevents double-observe

  function observe(el) {
    if (seen.has(el)) return
    seen.add(el)
    tracker.observe(el)
  }

  function unobserve(el) {
    if (!seen.has(el)) return
    seen.delete(el)
    tracker.unobserve(el)
  }

  function scan(root) {
    for (const el of find(root)) observe(el)
  }

  function handleMutations(mutations) {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue
        if (isMatch(node)) observe(node)
        // Walk subtree of the added node in case it brought matching descendants.
        scan(node)
      }
      for (const node of m.removedNodes) {
        if (node.nodeType !== 1) continue
        unobserve(node)
        if (typeof node.querySelectorAll === 'function') {
          // Best-effort: unobserve any tracked descendants of the removed subtree.
          // We don't know the caller's selector so we walk what we already observed.
          for (const child of node.querySelectorAll('*')) unobserve(child)
        }
      }
    }
  }

  function hookHistory() {
    if (typeof window === 'undefined' || !window.history) return null
    const origPush = window.history.pushState
    const origReplace = window.history.replaceState
    const wrap = orig => function (...args) {
      const ret = orig.apply(this, args)
      setTimeout(() => scan(document.body), 0)
      return ret
    }
    window.history.pushState = wrap(origPush)
    window.history.replaceState = wrap(origReplace)
    const onPop = () => setTimeout(() => scan(document.body), 0)
    window.addEventListener('popstate', onPop)
    return () => {
      window.history.pushState = origPush
      window.history.replaceState = origReplace
      window.removeEventListener('popstate', onPop)
    }
  }

  function start() {
    if (started || typeof window === 'undefined' || typeof document === 'undefined') return
    started = true
    tracker.start?.()

    const initialScan = () => scan(document.body)
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initialScan, { once: true })
    } else {
      initialScan()
    }

    if (typeof MutationObserver !== 'undefined') {
      mo = new MutationObserver(handleMutations)
      mo.observe(document.body, { childList: true, subtree: true })
    }

    historyHook = hookHistory()
  }

  function stop() {
    if (!started) return
    started = false
    historyHook?.()
    historyHook = null
    try { mo?.disconnect() } catch { /* ignore */ }
    mo = null
    tracker.stop?.()
  }

  return { start, stop, scan }
}
