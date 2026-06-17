// Adapter registry. buildAdapters() returns the enabled, configured adapters.
// Add a network = add a factory here + a doc in docs/networks/. See docs/05-networks.md.

import { createMeta } from './meta.js'
import { createTiktok } from './tiktok.js'
import { createGoogle } from './google.js'

const FACTORIES = { meta: createMeta, tiktok: createTiktok, google: createGoogle }

export function buildAdapters(networks = {}, deps = {}) {
  const adapters = []
  for (const [name, factory] of Object.entries(FACTORIES)) {
    const cfg = networks[name]
    if (!cfg || cfg.enabled === false) continue
    adapters.push(factory(cfg, deps))
  }
  return adapters
}
