import createIdentity from './identity.js'
import createEmitter from './emitter.js'
import createHttp from './http.js'
import createTransport from './transport.js'
import createConsent from './consent.js'
import { extractUtms, getReferrer } from './utms.js'

const VERSION = '0.2.0'

// Deep-merge two plain objects. Arrays and scalars from `b` replace `a`.
// Exposed via ctx for plugin authors who want to merge user-supplied config
// with their own defaults.
function deepMerge(a, b) {
  if (!a) return b ?? {}
  if (!b) return a
  if (typeof a !== 'object' || typeof b !== 'object') return b
  const out = { ...a }
  for (const k of Object.keys(b)) {
    const av = a[k], bv = b[k]
    if (bv && typeof bv === 'object' && !Array.isArray(bv) && av && typeof av === 'object' && !Array.isArray(av)) {
      out[k] = deepMerge(av, bv)
    } else {
      out[k] = bv
    }
  }
  return out
}

// Core whitebox client. Knows nothing about specific channels (mail, voip,
// engagement, …) — they are passed in as plugin instances and given a shared
// ctx during startup.
//
// Two ways to register plugins:
//   1. Constructor `plugins: [...]` array (preferred, started during wb.start()).
//   2. `wb.use(plugin)` after construction — installs immediately; useful for
//      late-bound plugins (lazy-loaded code, conditional features).
//
// The plugin contract:
//   {
//     name:    string                              // for logging + wb[name] attachment
//     install: (ctx) => Promise<teardown> | teardown | void
//   }
//
// `ctx` is a MUTABLE bag that plugins may both read and write. Read-only
// fields the core populates: url, http, transport, emitter, identity, consent,
// logger, deepMerge, queue, getPassportId, getSessionId, attach. Plugins are
// free to add their own fields; other plugins that read those fields must be
// initialized AFTER the writer. Order is the order of the `plugins: [...]`
// array in the constructor.
export default function whitebox(options = {}) {
  const {
    url,
    transport: transportEnabled = true,  // socket.io is the canonical transport
    autoResolveSession = true,
    plugins: pluginInstances = [],       // plugin instances created by the caller
    consent: consentOptions = {},        // { required: [...] }
    logger = console,
  } = options

  if (!url) throw new Error('whitebox: `url` is required')

  const identity = createIdentity()
  const emitter = createEmitter()
  const http = createHttp({ baseUrl: url })
  const consent = createConsent({
    emitter,
    required: consentOptions.required || [],
  })

  let sessionId = identity.getSessionId()
  let passportId = identity.getPassportId()
  let ready = null
  const installed = new Map()       // name → api attached via ctx.attach(name, api)
  const teardowns = []              // collected from each plugin's install() return value
  const callQueue = []

  const transport = transportEnabled
    ? createTransport({
        url,
        getSessionId: () => sessionId,
        getPassportId: () => passportId,
        emitter,
        logger,
      })
    : null

  async function resolveSessionFromServer() {
    try {
      const body = {
        passport_id: passportId || null,
        utms: extractUtms(),
        referrer: getReferrer(),
      }
      const res = await http.request('/sessions/resolve', { method: 'POST', body })
      if (res?.sessionId) {
        sessionId = res.sessionId
        identity.setSessionId(res.sessionId)
      }
      if (res?.passportId) {
        passportId = res.passportId
        identity.setPassportId(res.passportId)
      }
    } catch (err) {
      logger?.warn?.('whitebox: session resolve failed', err)
    }
  }

  // Anything called before ready is queued and replayed
  function queue(fn) {
    if (ready) return fn()
    return new Promise((resolve, reject) => {
      callQueue.push(async () => {
        try { resolve(await fn()) }
        catch (err) { reject(err) }
      })
    })
  }

  // Build the ctx bag shared with every plugin. Mutable — plugins may augment.
  // `consent` is built-in (not a plugin) so any plugin can check
  // ctx.consent.has('analytics') from its install() without worrying about
  // plugin ordering.
  const ctx = {
    url,
    http,
    transport,
    emitter,
    identity,
    consent,
    logger,
    deepMerge,
    queue,
    getPassportId: () => passportId,
    getSessionId:  () => sessionId,
    // Adopt a passport resolved out-of-band (e.g. a shortener claim binding the
    // visitor to a known customer) so subsequent events run as that passport.
    setPassportId(id) { if (id) { passportId = id; identity.setPassportId(id) } },
    // Convenience for plugins that want to expose an API onto the wb object.
    attach(name, api) { wb[name] = api; installed.set(name, api) },
  }

  // Install a single plugin instance synchronously *or* asynchronously.
  // Records its teardown for wb.destroy().
  async function installPlugin(plugin) {
    if (!plugin || typeof plugin.install !== 'function') {
      throw new Error('whitebox: plugin must expose an install(ctx) function')
    }
    logger?.debug?.('whitebox: installing plugin %s', plugin.name || '(anonymous)')
    const result = await plugin.install(ctx)
    if (typeof result === 'function') teardowns.push({ name: plugin.name, fn: result })
  }

  async function init() {
    if (autoResolveSession) await resolveSessionFromServer()

    if (transport) {
      await transport.open().catch(err => {
        logger?.warn?.('whitebox: transport open failed', err)
      })
    }

    // Install constructor-time plugins in declared order. Mutable ctx means
    // a later plugin can read state attached by an earlier one (e.g. consent).
    for (const plugin of pluginInstances) {
      try { await installPlugin(plugin) }
      catch (err) { logger?.error?.('whitebox: plugin install failed: %s', plugin?.name, err) }
    }

    emitter.emit('ready')
    while (callQueue.length) {
      const fn = callQueue.shift()
      try { await fn() } catch (err) { logger?.warn?.('queued call failed', err) }
    }
  }

  const wb = {
    version: VERSION,
    get ready() { return ready },

    // Identity
    get passportId() { return passportId },
    get sessionId() { return sessionId },

    // Built-in: consent gate. Same instance handed to plugins via ctx.consent.
    consent,

    // Late-bound plugin registration (after constructor). Returns wb for chaining.
    // Validates the plugin shape synchronously, then kicks off install. If the
    // plugin needs ready state, use `ctx.queue(fn)` inside its install.
    use(plugin) {
      if (!plugin || typeof plugin.install !== 'function') {
        throw new Error('whitebox: plugin must expose an install(ctx) function')
      }
      installPlugin(plugin).catch(err => {
        logger?.error?.('whitebox: late plugin install failed: %s', plugin?.name, err)
      })
      return wb
    },

    // Plugins installed (by name) — useful for cross-plugin lookups.
    plugin(name) { return installed.get(name) ?? null },

    // Event subscription
    on: emitter.on,
    off: emitter.off,

    // Teardown — calls each plugin's returned teardown fn in reverse install order
    destroy() {
      while (teardowns.length) {
        const { name, fn } = teardowns.pop()
        try { fn() } catch (err) { logger?.warn?.('whitebox: teardown for %s failed', name, err) }
      }
      transport?.close()
      emitter.clear()
    },

    // Clear local state (GDPR forget on the client side; pair with server-side delete)
    forget() {
      identity.clear()
      consent.clear()
      passportId = null
      sessionId = null
      transport?.close()
    },
  }

  ready = init()
  return wb
}
