# Conversions Plugin

> Server side of conversion tracking — records each browser/server event as a first-party awareness signal and fans it out to the ad networks (Meta CAPI / GA4 MP / TikTok Events API), deduped against the browser pixels by `event_id`.

## What it is

Server side of conversion tracking. Receives standard/custom conversion events
from the browser ([`whitebox-pro-client-plugin-conversions`](../whitebox-pro-client-plugin-conversions)),
records each as a first-party **awareness** signal, and — consent permitting —
fans it out to the ad networks (Meta CAPI / GA4 MP / TikTok Events API) through
the shared [`whitebox-pro-adnetworks`](../whitebox-pro-adnetworks) adapters, **deduped
against the browser pixels by `event_id`**.

## Config

```js
import { conversions } from 'whitebox-pro-server-plugin-conversions'
import { meta } from 'whitebox-pro-adnetworks-meta'
import { tiktok } from 'whitebox-pro-adnetworks-tiktok'

conversions({
  auth: { secret: process.env.WB_CONVERSIONS_TOKEN },   // Bearer for GET /conversions/events
  // Compose the server-side (SST) networks — each a self-contained package
  // called with its creds. (GA4 is usually client-gtag only — see Dedup below.)
  networks: [
    meta({ pixelId: process.env.WB_META_PIXEL_ID, accessToken: process.env.WB_META_CAPI_TOKEN }),
    tiktok({ pixelCode: process.env.WB_TIKTOK_PIXEL_CODE, accessToken: process.env.WB_TIKTOK_EVENTS_TOKEN }),
  ],
  // Optional server-side consent enforcement (the client already gates on
  // marketing consent before sending, so this is OFF by default):
  // consent: { require: true, check: async (passportId) => /* … */ true },
})
```

A network only fires when its credentials are present (`eligible`). With no
networks composed the plugin still records conversions into awareness — it just
doesn't forward anywhere.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/conversions/events` | public | Browser ingress. Body `{ passport_id, events: [...], signals? }`. |
| `GET`  | `/conversions/events` | Bearer | Inspect the audit log (`?passport_id=&limit=&offset=`). |

**Trust model:** the `POST` is public (the browser holds no secret). The
`passport_id` the client carries — minted at `/sessions/resolve` — *is* the
identifier, same as the rest of the browser ingress. No session lookup.

**Idempotency:** `event_id` is unique. The browser may double-fire (sendBeacon
on unload), and it's the key the network pixels dedupe on, so we do too.

## Validation

Standard-event payloads validate against the **same** schemas the client uses
(`whitebox-pro-adnetworks/schemas`), so client and server can never disagree about
what a `purchase` looks like.

## MCP

- `conversions.list_events` — recent events + per-network delivery status (optionally per passport).
- resource `conversions-events`.
