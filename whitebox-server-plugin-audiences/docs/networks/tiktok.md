# TikTok

Adapter: [`src/adapters/tiktok.js`](../../src/adapters/tiktok.js) — **Mode A** via the Events API.

## Flow

```
WhiteBox → Events API custom event (wb_<segment>, hashed user, event_id)
        → you create a Custom Audience from that activity
        → target your creative
```

## Config

```js
audiences.networks.tiktok = {
  enabled: true,
  pixelCode:   process.env.WB_TIKTOK_PIXEL_CODE,    // the Pixel / event_source_id
  accessToken: process.env.WB_TIKTOK_EVENTS_TOKEN,  // Events API access token
}
```

Eligible when `pixelCode` + `accessToken` are set.

## API called

`POST https://business-api.tiktok.com/open_api/v1.3/event/track/` with header `Access-Token: …`

```json
{ "event_source": "web", "event_source_id": "<pixelCode>",
  "data": [{
    "event": "wb_enterprise_ready",
    "event_time": 1718600000,
    "event_id": "enterprise_ready:8c5a…:2026-06-17",
    "user": { "email": "<sha256>", "phone": "<sha256>", "ttclid": "...", "ttp": "..." }
}]}
```

A successful response has `code: 0`.

## Identity it needs

- **Browser-collected:** `ttclid` (URL param), `_ttp` cookie.
- **Server-resolved:** SHA-256 email/phone, IP + user agent.

## Create the audience (one-time)

Ads Manager → Assets → Audiences → Custom Audience → from your event activity (or engagement) →
choose `wb_enterprise_ready` → set the retention window (≥ `keepWarmDays`).

## Gotchas

- Hash email/phone with SHA-256 (lowercased/trimmed email; E.164-digits phone).
- Min audience size before it serves (~1,000) is the platform's concern — Mode A pools over the window.
- Consent applies — see [08](08-consent-privacy.md).
