# 05 · Networks

All three networks use **Mode A**: WhiteBox fires a custom event, the platform builds the audience.
Each network is an **adapter** — data plus one method.

## The adapter contract

```js
{
  name: 'meta',
  modes: ['event'],                 // ['event','membership'] in v2
  eligible: <bool>,                 // true only when its secrets are configured
  transport: 'http' | 'ga4',
  identitySpec: [ … ],              // browser signals the client must collect (→ the manifest)
  acceptedKeys: [ … ],              // which identity keys this network can match on
  async sendEvent(canonical, ids) { … }   // fire one event; return { status, matched_via, error }
}
```

- **`identitySpec`** flows server → client: the union across eligible adapters becomes the
  collection manifest. See [06 · Identity](06-identity.md).
- **`acceptedKeys`** is consumed server-side at send time — the core resolves a passport's identity and
  the adapter picks the subset it can use.
- **`sendEvent`** receives a `canonical` event `{ event, event_id, ts, value? }` and the resolved
  `ids` `{ email_sha256, phone_sha256, external_id, signals, ip?, user_agent? }`.

Add a network = add an adapter factory in [`src/adapters/`](../src/adapters), register it in
`adapters/index.js`, and write a `docs/networks/<net>.md`.

## Eligibility

A network is **eligible** only when its credentials are present in config. `audiences_network_status`
/ `GET /audiences/networks` reports eligibility so you (and the agent) know what's targetable before
authoring rules.

## Encoding the segment: one event name per segment

In Mode A the segment is the **rule on your event**. To keep that rule trivial and reliable on every
platform, **fire a distinct custom event name per segment** (`wb_enterprise_ready`,
`wb_trial_hesitant`). Put metadata (`score`, etc.) in event params, not the segment key — Meta's
custom-parameter audience filtering is spotty and you lose standard-event optimization.

## `event_id` and dedup

The core builds `event_id = "<rule>:<passport>:<yyyy-mm-dd>"`:
- **idempotent within a day** (re-runs don't double-count),
- **fresh across days** so keep-warm re-fires refresh the platform's recency window,
- **shared with the browser pixel** if you also fire client-side, so the network deduplicates
  browser + server.

## Per-network setup

- **[Meta](networks/meta.md)** — Conversions API custom event → Website Custom Audience.
- **[TikTok](networks/tiktok.md)** — Events API custom event → Custom Audience.
- **[Google / GA4](networks/google-ga4.md)** — Measurement Protocol event → GA4 audience → Google Ads / DV360.

## The platform-side step (one-time, per segment)

WhiteBox fires events; **you create the audience rule once** on each platform:

> *Custom Audience = people who triggered `wb_<segment>` in the last N days.*

Set N (the lookback window) ≥ your `keepWarmDays` so re-fires keep people in. After that, it's
automatic — WhiteBox keeps firing for qualifiers, the platform keeps the audience fresh.
