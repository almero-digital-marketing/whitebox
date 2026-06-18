// whitebox-adnetworks — shared ad-network transport.
//
// The adapter contract (data + one method):
//   { name, modes, eligible, transport?, identitySpec[], acceptedKeys[],
//     async sendEvent(canonical, ids) → { status, matched_via?, error? } }
//
//   canonical : { event | standard, event_id, ts, value?, currency?, content_ids?, ... }
//               - { event: 'wb_high_intent' }   custom event   (audiences)
//               - { standard: 'purchase', value, currency }   standard event (analytics)
//   ids       : { email_sha256, phone_sha256, external_id, signals{}, ip?, user_agent? }
//
// Consumers resolve a passport → ids (hashing via this package) and gate on
// consent themselves; the adapters just fire.

export { buildAdapters } from './adapters/index.js'
export { NETWORK_NAMES, PIXEL_GLOBAL, selectedNetworks } from './networks.js'
export { STANDARD_EVENTS, resolveEventName } from './taxonomy.js'
export { hashEmail, hashPhone, sha256, composeManifest, pick } from './identity.js'

export { createMeta } from './adapters/meta.js'
export { createTiktok } from './adapters/tiktok.js'
export { createGoogle } from './adapters/google.js'
