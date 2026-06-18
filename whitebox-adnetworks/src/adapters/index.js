import { createMeta } from './meta.js'
import { createTiktok } from './tiktok.js'
import { createGoogle } from './google.js'
import { selectedNetworks } from '../networks.js'

const FACTORIES = { meta: createMeta, tiktok: createTiktok, google: createGoogle }

// Build the configured adapters from a networks config block, using the SAME
// selection logic the client uses to pick pixels (whitebox-adnetworks/networks),
// so both sides share one vocabulary. (enabled:false or a falsy value ⇒ skip.)
//   networks: { meta:{…}, tiktok:{…}, google:{…} }
export function buildAdapters(networks = {}, deps = {}) {
  return selectedNetworks(networks).map(name => FACTORIES[name](networks[name], deps))
}
