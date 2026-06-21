# Meta (Facebook / Instagram)

Adapter: [`src/adapters/meta.js`](../../../adnetworks/src/adapters/meta.js) — **Mode A** via the Conversions API.

## Flow

```
WhiteBox → Conversions API custom event (wb_<segment>, hashed user_data, event_id)
        → you create a Website Custom Audience: "triggered wb_<segment> in last N days"
        → target your creative at that audience
```

## Config

```js
audiences.networks.meta = {
  enabled: true,
  pixelId:     process.env.WB_META_PIXEL_ID,      // the Dataset / Pixel ID
  accessToken: process.env.WB_META_CAPI_TOKEN,    // a System User token with ads_management
  testEventCode: process.env.WB_META_TEST_EVENT_CODE, // optional; dev only — see Test Events
}
```

Eligible when `pixelId` + `accessToken` are set.

## API called

`POST https://graph.facebook.com/v19.0/{pixelId}/events?access_token=…`

```json
{ "data": [{
  "event_name": "wb_enterprise_ready",
  "event_time": 1718600000,
  "event_id": "enterprise_ready:8c5a…:2026-06-17",
  "action_source": "website",
  "user_data": { "em": "<sha256>", "ph": "<sha256>", "fbp": "...", "fbc": "...",
                 "client_ip_address": "...", "client_user_agent": "..." }
}]}
```

## Identity it needs

- **Browser-collected** (manifest → [06](06-identity.md)): `_fbp` cookie, `_fbc` cookie (or built from
  the `fbclid` URL param via the `build_fbc` transform).
- **Server-resolved:** SHA-256 email/phone, client IP + user agent (best from the forwarded request).

Match rate rises with more keys — email + `fbp`/`fbc` together is much better than email alone.

## Create the audience (one-time)

Ads Manager → Audiences → Create Custom Audience → **Website** → *Events* → choose your custom event
(`wb_enterprise_ready`) → set retention (1–180 days; use ≥ your `keepWarmDays`). Server (CAPI) events
populate Website Custom Audiences as long as they're matched to a user.

## Gotchas

- A purely server-side event still needs good match keys (`em`/`fbp`/`fbc`) to attribute to a person.
- Use **Test Events** (`test_event_code`) while developing — confirm events arrive before creating the
  audience.
- Custom **parameter** filtering on audiences is limited; rely on the **event name** per segment.
- Honor consent — see [08](08-consent-privacy.md). Meta also has its own data-use / consent terms.
