// Minimal pub/sub. No deps. ~30 lines gzipped to almost nothing.

export default function createEmitter() {
  const listeners = new Map()  // event → Set<fn>

  function on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event).add(fn)
    return () => off(event, fn)
  }

  function off(event, fn) {
    listeners.get(event)?.delete(fn)
  }

  function emit(event, data) {
    const set = listeners.get(event)
    if (!set) return
    for (const fn of set) {
      try { fn(data) }
      catch (err) { /* swallow — don't let one listener break others */ }
    }
  }

  function clear() {
    listeners.clear()
  }

  return { on, off, emit, clear }
}
