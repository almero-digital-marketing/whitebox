// Identity persistence: passport_id (localStorage, long-lived) and session_id
// (sessionStorage, per-tab). Owns its keys and its localStorage access.
//
// Designed to read/write through `try`/`catch` so private browsing modes,
// disabled storage, or SSR environments don't break the rest of the client
// — falls back to an in-memory copy that survives within the page lifetime.
//
// Exposed to plugins via `ctx.identity` so they can read the current passport
// or session without reaching into browser APIs themselves.

const PASSPORT_KEY = 'wb:passport_id'
const SESSION_KEY  = 'wb:session_id'

function safeGet(store, key) { try { return store?.getItem(key) }    catch { return null } }
function safeSet(store, key, value) { try { store?.setItem(key, value) } catch { /* swallow */ } }
function safeRemove(store, key) { try { store?.removeItem(key) }     catch { /* swallow */ } }

export default function createIdentity() {
  const isBrowser = typeof window !== 'undefined'
  const local   = isBrowser ? window.localStorage   : null
  const session = isBrowser ? window.sessionStorage : null
  const memory = { local: {}, session: {} }

  function getPassportId() {
    return safeGet(local, PASSPORT_KEY) ?? memory.local[PASSPORT_KEY] ?? null
  }
  function setPassportId(id) {
    safeSet(local, PASSPORT_KEY, id)
    memory.local[PASSPORT_KEY] = id
  }

  function getSessionId() {
    return safeGet(session, SESSION_KEY) ?? memory.session[SESSION_KEY] ?? null
  }
  function setSessionId(id) {
    const value = String(id)
    safeSet(session, SESSION_KEY, value)
    memory.session[SESSION_KEY] = value
  }

  function clear() {
    safeRemove(local, PASSPORT_KEY)
    safeRemove(session, SESSION_KEY)
    memory.local = {}
    memory.session = {}
  }

  return { getPassportId, setPassportId, getSessionId, setSessionId, clear }
}
