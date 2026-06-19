// Per-passport structured context registry.
//
// Plugins register a `contextFor(passportId, opts)` function under a short
// name. Consumers (today: analytics /ask) call `collect(passportId, opts)`
// and get back `{ [name]: <whatever the provider returned> }`.
//
// Decoupling rule: consumers never import providers, providers never import
// consumers. The registry is the only shared surface. Adding a new context
// source = one `register()` call in that plugin's setup.
//
// Providers are expected to:
//   - return JSON-serializable data (string / number / array / plain object / null)
//   - respect `opts.limit` (default 20) so token budgets stay bounded
//   - be cheap (one indexed DB query, no LLM calls); collect runs every /ask
//   - never throw — errors are caught and surfaced as `null` for that key

// Dependencies + state captured once via init() — module-level singleton, no
// wrapping factory closure. Matches the core pattern (passports, sessions, …).
// init() rebuilds the providers Map, so a fresh init() fully resets state.
let logger
let providers = new Map()

export function init(deps = {}) {
  logger = deps.logger
  providers = new Map()
}

export function register(name, fn) {
  if (typeof name !== 'string' || !name) throw new Error('context.register: name required')
  if (typeof fn !== 'function') throw new Error('context.register: fn must be a function')
  if (providers.has(name)) {
    logger?.warn?.('context.register: overwriting existing provider "%s"', name)
  }
  providers.set(name, fn)
}

export function unregister(name) {
  providers.delete(name)
}

export function names() {
  return [...providers.keys()]
}

// collect(passportId, opts)
//   opts.providers? : string[]      — filter to these names only. Unknown names are ignored.
//   opts.limit?     : number = 20   — passed to each provider (page size)
//   opts.offset?    : number = 0    — passed to each provider (paging)
//   opts.question?  : string        — free-form hint for providers that want it
//
// Returns { [providerName]: <whatever the provider returned> }
export async function collect(passportId, opts = {}) {
  if (!passportId) return {}
  const limit = opts.limit ?? 20
  const offset = opts.offset ?? 0
  const filter = Array.isArray(opts.providers) && opts.providers.length
    ? new Set(opts.providers)
    : null

  const out = {}
  // Sequential — order is stable and providers tend to be DB-bound.
  // Parallel would be a micro-optimization; revisit if collect ever blocks /ask.
  for (const [name, fn] of providers) {
    if (filter && !filter.has(name)) continue
    try {
      out[name] = await fn(passportId, { ...opts, limit, offset })
    } catch (err) {
      logger?.warn?.({ err, provider: name }, 'context provider failed')
      out[name] = null
    }
  }
  return out
}
