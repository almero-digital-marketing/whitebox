# whitebox-adnetworks

**Shared ad-network transport for WhiteBox** — Meta (Conversions API), TikTok (Events API), and Google
(GA4 Measurement Protocol). One adapter contract, used by two plugins:

- **`whitebox-server-plugin-audiences`** fires **custom** events (`wb_high_intent`) for audience building.
- **`whitebox-server-plugin-analytics`** fires **standard** events (`purchase`, `lead`, …) for conversion tracking.

It's a thin, framework-agnostic library: adapters + a standard-event taxonomy + identity hashing +
client-manifest composition. No WhiteBox imports — consumers resolve passports → identity and gate on
consent themselves; the adapters just fire.

## The adapter contract

```js
{
  name: 'meta',
  modes: ['event'],                 // ['event','membership'] reserved for v2
  eligible: <bool>,                 // true only when this network's secrets are configured
  transport: 'http' | 'ga4',
  identitySpec: [ … ],              // browser signals the client must collect (→ the manifest)
  acceptedKeys: [ … ],              // identity keys this network can match on
  async sendEvent(canonical, ids) → { status, matched_via?, error? }
}
```

### `canonical` — custom OR standard

```js
// custom (audiences): name passes straight through
{ event: 'wb_high_intent', event_id, ts }

// standard (analytics): mapped to each network's name via the taxonomy
{ standard: 'purchase', event_id, ts, value: 49.0, currency: 'USD', content_ids: ['sku_1'] }
```

### `ids` — resolved identity

```js
{ email_sha256, phone_sha256, external_id, signals: { fbp, fbc, ttclid, ga_client_id, … }, ip?, user_agent? }
```

## API

```js
import {
  buildAdapters,            // (networks, { logger }) → [adapter]  — enabled+configured only
  STANDARD_EVENTS,          // canonical → per-network standard event names
  resolveEventName,         // (canonical, network) → the network's event name
  hashEmail, hashPhone,     // normalize + SHA-256 (what networks match on)
  composeManifest,          // (adapters) → { collect: [...] }  the client-collection manifest
  createMeta, createTiktok, createGoogle,
} from 'whitebox-adnetworks'
```

### Build adapters from config

```js
const adapters = buildAdapters({
  meta:   { enabled: true, pixelId: …, accessToken: … },
  tiktok: { enabled: true, pixelCode: …, accessToken: … },
  google: { enabled: true, measurementId: …, apiSecret: … },
}, { logger })
```

### Fire a standard conversion event (analytics)

```js
const ids = { email_sha256: hashEmail(email), phone_sha256: hashPhone(phone),
              external_id: passportId, signals }   // signals from the client capture shim
for (const a of adapters) {
  if (a.eligible) await a.sendEvent(
    { standard: 'purchase', event_id, ts: new Date().toISOString(), value: 49, currency: 'USD' },
    ids)
}
```

`whitebox-server-plugin-analytics` wraps exactly this as `ctx.plugins.analytics.reportStandardEvent`.

### Fire a custom event (audiences)

```js
await adapter.sendEvent({ event: 'wb_high_intent', event_id, ts }, ids)
```

## Standard-event taxonomy

`STANDARD_EVENTS` maps a canonical vocabulary to each network's name, e.g.:

| canonical | Meta | TikTok | GA4 |
|---|---|---|---|
| `purchase` | `Purchase` | `CompletePayment` | `purchase` |
| `lead` | `Lead` | `SubmitForm` | `generate_lead` |
| `view_content` | `ViewContent` | `ViewContent` | `view_item` |
| `add_to_cart` | `AddToCart` | `AddToCart` | `add_to_cart` |
| `begin_checkout` | `InitiateCheckout` | `InitiateCheckout` | `begin_checkout` |

Full list in [`src/taxonomy.js`](src/taxonomy.js). An unknown `standard` falls back to its canonical
name.

## Identity & manifest

- **Hashing:** `hashEmail` (lowercase/trim) and `hashPhone` (E.164 digits) → SHA-256. Networks match on
  these — raw PII never leaves your server.
- **Manifest:** `composeManifest(adapters)` returns the union of eligible adapters' `identitySpec` — the
  declarative list of cookies/URL-params the client capture shim must collect (`_fbp`, `ttclid`,
  `_ga` client_id, …). It's data, not code. See the audiences plugin's `docs/06-identity.md` for the
  client side.

## What this does NOT do

- **Consent** — gate before calling `sendEvent`; this package never decides who's eligible.
- **Passport → identity** — consumers resolve email/phone (and browser signals) and pass `ids`.
- **Membership / audience upload (Mode B)** — only event firing (Mode A) for now.

## Add a network

Add `src/adapters/<net>.js` exporting a `create<Net>(cfg, { logger })` that returns the contract, add
it to `src/adapters/index.js`'s `FACTORIES`, and extend `STANDARD_EVENTS` with its names.
