// whitebox-adnetworks — the shared kernel for ad-network conversion tracking.
//
// Per-network specifics (event-name maps, signal specs, the CAPI/MP/Events-API
// adapter, and the browser pixel) live in their own packages —
// whitebox-adnetworks-meta / -google / -tiktok — and are COMPOSED as factories:
//
//   server:  conversions({ networks: [ meta({ pixelId, accessToken }), … ] })
//   client:  conversions({ networks: [ meta(), tiktok() ] })   // from `/client`
//
// A composed network descriptor:
//   server  { name, signals[], eligible, async sendEvent(canonical, ids) }
//   client  { name, signals[], present(), collect(), fire(kind, name, payload, eventId) }
//
// This package holds only the cross-network kernel: the canonical event
// vocabulary, the payload schemas, and identity hashing / manifest composition.

export { CANONICAL_EVENTS } from './events.js'
export { EVENT_SCHEMAS, CONVERSION_EVENTS, baseEventSchema, validateEvent, validateCustom } from './schemas.js'
export { hashEmail, hashPhone, sha256, composeManifest, pick } from './identity.js'
