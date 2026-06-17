# Google (via GA4)

Adapter: [`src/adapters/google.js`](../../src/adapters/google.js) — **Mode A** via the GA4
**Measurement Protocol**. GA4 is the common denominator: to do almost anything in Google Ads/DV360 you
route through GA4 audiences.

## Flow

```
WhiteBox → GA4 Measurement Protocol event (wb_<segment>, client_id)
        → you build a GA4 audience (event- or user-property-based)
        → GA4 auto-shares it to linked Google Ads + DV360
        → target your creative
```

Google has **no "audience from a CAPI event"** like Meta/TikTok — the event→audience path *is* GA4.

## Config

```js
audiences.networks.google = {
  enabled: true,
  measurementId: process.env.WB_GA4_MEASUREMENT_ID,  // 'G-XXXXXXX' (per data stream)
  apiSecret:     process.env.WB_GA4_API_SECRET,       // Admin → Data Streams → MP API secrets
}
```

Eligible when `measurementId` + `apiSecret` are set.

## API called

`POST https://www.google-analytics.com/mp/collect?measurement_id=…&api_secret=…`

```json
{ "client_id": "1234567.7654321",
  "user_id": "<passport or hashed crm id, optional>",
  "events": [{ "name": "wb_enterprise_ready",
               "params": { "engagement_time_msec": 1, "session_id": "<event_id>" } }],
  "user_properties": { "wb_segment": { "value": "enterprise_ready" } } }
```

Success is **HTTP 204 with no body**. Use the **validation endpoint**
`https://www.google-analytics.com/debug/mp/collect` in dev — MP fails silently otherwise.

## The critical identity: the GA4 `client_id`

GA4 ties a server event to the user's real browsing via the `_ga` cookie's `client_id`. **Without the
real `client_id`, MP creates a phantom user that won't populate audiences tied to actual sessions.** So
the client capture shim **must** read `_ga` → `client_id` (via the `ga_cid` transform). Optionally set
`user_id` for cross-device. See [06 · Identity](06-identity.md).

## Event vs user property

GA4 audiences can key on **events** (happened) or **user properties** (current state):
- action-style segment → custom **event** (`wb_refund_read`).
- membership-style segment → set a **user property** (`wb_segment = enterprise_ready`) — gives you a
  pseudo-current-state within GA4. The adapter supports both (`canonical.user_property`).

## Create the audience (one-time)

GA4 → Admin → Audiences → New → condition on your event name (or user property) within a lookback →
ensure the GA4 property is **linked to Google Ads**. The audience then appears in Google Ads for
targeting. Expect ~24–48h population lag (this is the Mode A "time lag").

## Gotchas

- Reserved event/param names + naming rules apply.
- `api_secret` is **per data stream** — match it to `measurement_id`.
- Include `engagement_time_msec`/`session_id` or events may not qualify for audiences.
- Customer Match (direct upload) is the **Mode B** alternative for Google — a v2 upgrade.
