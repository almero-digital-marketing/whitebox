# whitebox-adnetworks

The shared **kernel** for ad-network conversion tracking. Per-network specifics
live in their **own self-contained repos** (each released independently; clone
into `./integrations` for local dev) and are **composed** like plugins:

- `whitebox-adnetworks-meta` — Meta (Conversions API + Pixel)
- `whitebox-adnetworks-google` — GA4 (Measurement Protocol + gtag)
- `whitebox-adnetworks-tiktok` — TikTok (Events API + Pixel)

Each owns everything about its network — the canonical→network event map, the
browser signal specs, the server adapter, and the client pixel — and is called
as a factory:

```js
// server (whitebox.config.js) — fan-out leg, with creds
import { meta }   from 'whitebox-adnetworks-meta'
import { tiktok } from 'whitebox-adnetworks-tiktok'
conversions({ networks: [ meta({ pixelId, accessToken }), tiktok({ pixelCode, accessToken }) ] })

// client (browser) — pixel leg, no creds (the base snippet carries the id)
import { meta } from 'whitebox-adnetworks-meta/client'
conversions({ networks: [ meta(), tiktok() ] })
```

A composed network descriptor:

| surface | shape |
|---|---|
| server (`.`) | `{ name, signals[], eligible, modes, transport, async sendEvent(canonical, ids) }` |
| client (`/client`) | `{ name, signals[], present(), collect(), fire(kind, name, payload, eventId) }` |
| spec (`/spec`) | pure: `{ name, pixelGlobal, events, signals, eventName(canonical) }` |

## What this kernel provides

- **`./schemas`** — zod payload schemas (`validateEvent`, `validateCustom`, `CONVERSION_EVENTS`). Client-safe.
- **`./browser`** — pure client helpers (`cookie`, `param`, `removeUndefined`, `toItems`) the pixels use.
- **`.`** — the above plus `CANONICAL_EVENTS` and identity helpers (`hashEmail`, `hashPhone`, `composeManifest`, `pick`). Server-side (uses `node:crypto`).

`composeManifest(networks)` unions the eligible networks' `signals` into the
declarative client-collection manifest. Adding a network = a new package; no
edits to a central registry.
