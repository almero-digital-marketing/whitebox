// Consent management — built-in core concern, not a plugin.
//
// Consent is a cross-cutting gate: any channel may need to check whether
// the user has granted a particular category (analytics, marketing, …)
// before sending data. Living in core means:
//
//   - Plugins can read `ctx.consent.has(category)` during install() without
//     worrying about ordering (was the consent plugin installed first?).
//   - It's always available — easy to forget if it were optional.
//
// State persists to localStorage under a single `wb:consent` key (an object
// of category → boolean). Safe to call in SSR / private browsing — falls
// back to an in-memory copy. Events fire on the shared emitter:
// `consent:granted` / `consent:revoked`.

const CONSENT_KEY = 'wb:consent'

function safeGet(store, key) { try { return store?.getItem(key) }    catch { return null } }
function safeSet(store, key, value) { try { store?.setItem(key, value) } catch { /* swallow */ } }
function safeRemove(store, key) { try { store?.removeItem(key) }     catch { /* swallow */ } }

export default function createConsent({ emitter, required = [] } = {}) {
  if (!emitter) throw new Error('consent: emitter is required')

  const isBrowser = typeof window !== 'undefined'
  const local = isBrowser ? window.localStorage : null
  let memory = null  // populated on first miss; mirrors what was written

  function read() {
    const raw = safeGet(local, CONSENT_KEY) ?? memory
    if (!raw) return {}
    try { return JSON.parse(raw) } catch { return {} }
  }
  function write(state) {
    const json = JSON.stringify(state)
    safeSet(local, CONSENT_KEY, json)
    memory = json
  }

  function grant(category) {
    const c = read()
    c[category] = true
    write(c)
    emitter.emit('consent:granted', { category })
  }

  function revoke(category) {
    const c = read()
    c[category] = false
    write(c)
    emitter.emit('consent:revoked', { category })
  }

  function has(category) {
    return !!read()[category]
  }

  // Has the user made an explicit choice about this category — granted OR denied?
  // `has()` is false for both "denied" and "never asked"; this tells them apart,
  // so UI can show a consent prompt only until it's been answered (and not
  // re-prompt on every reload, since the choice persists).
  function decided(category) {
    return category in read()
  }

  function allGranted() {
    return required.every(c => has(c))
  }

  function clear() {
    safeRemove(local, CONSENT_KEY)
    memory = null
  }

  return { grant, revoke, has, decided, allGranted, clear, required }
}
