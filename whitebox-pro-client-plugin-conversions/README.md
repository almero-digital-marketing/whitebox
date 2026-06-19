# whitebox-pro-client-plugin-conversions

Browser side of conversion tracking. Each call does two things under one shared
`event_id` (so the platforms dedupe):

1. **fires the browser pixels** present on the page (`fbq` / `gtag` / `ttq`), and
2. **POSTs to whitebox-pro-server** (`/conversions/events`), which records the event
   into awareness and fans out the server-side hits (Meta CAPI / TikTok Events
   API) via [`whitebox-pro-adnetworks`](../whitebox-pro-adnetworks).

The pixel base snippets are **loaded + init'd elsewhere** (your page / GTM / a
consent-mode loader) — this plugin never loads or `init`s them, it only fires
events on globals that are already present. A missing pixel is a silent no-op.

## Usage

```js
import { createClient } from 'whitebox-pro-client'
import conversions from 'whitebox-pro-client-plugin-conversions'

const wb = createClient({ /* … */, plugins: [ conversions() ] })

// one zod-validated method per standard event
wb.conversions.purchase({ value: 49.99, currency: 'USD', content_ids: ['sku-1'], num_items: 2 })
wb.conversions.viewContent({ content_ids: ['sku-1'] })
wb.conversions.addToCart({ content_ids: ['sku-1'], value: 12, currency: 'USD' })
wb.conversions.search({ search_string: 'whitening' })
wb.conversions.lead() / pageView() / subscribe() / contact() / …

// generics
wb.conversions.track('add_to_cart', { content_ids: ['z'] })
wb.conversions.custom('wb_high_intent', { value: 1, meta: { tier: 'gold' } })
```

Methods validate their payload (throwing on invalid input) against the shared
schemas in `whitebox-pro-adnetworks/schemas` — the **same** schemas the server uses,
so client pixels, server CAPI, and awareness can't disagree about shape.

## Options

```js
import { meta }   from 'whitebox-pro-adnetworks-meta/client'
import { google } from 'whitebox-pro-adnetworks-google/client'
import { tiktok } from 'whitebox-pro-adnetworks-tiktok/client'

conversions({
  consentCategory: 'marketing',            // consent category that gates sends (default)
  requireConsent: true,                    // false ⇒ send regardless of consent
  networks: [ meta(), google(), tiktok() ],// composed client pixels — fire whichever is present
  sst: true,                               // also POST to the server (false ⇒ pixels only)
})
```

`networks` is composed from each network package's `/client` entry — the same
packages the server composes (with creds). Whichever pixels are actually present
on the page fire; a missing one is a no-op.

## Signals

On each send the plugin unions each composed network's `collect()` — the
browser-only ad cookies its server API matches on (Meta `_fbp`/`_fbc`, GA4
`_ga` → `client_id`, TikTok `_ttp`/`ttclid`) — and includes them in the POST so
the server-side CAPI/MP hits can match the user. See [signals.js](src/signals.js).

Each network owns its own cookies + transforms in its package, so this is just a
merge over the composed networks — only the networks you compose are collected.

## Dedup & GA4

- **Meta / TikTok** fire **both** sides — client pixel + server SST — deduped by
  the shared `event_id`. ✓
- **GA4** is **client-side only** (the `gtag` pixel). GA4 has no `event_id` dedup
  between `gtag` and the Measurement Protocol, so do **not** also configure the
  `google` network on the server — non-purchase events would double-count.
  (Keeping GA4 in the browser is also just easier to debug — GA4 DebugView + the
  network tab.) `transaction_id` is still threaded through so `gtag` dedupes its
  own duplicate purchases (e.g. a confirmation-page refresh).

The signals collected above (`_fbp`/`_fbc`, `_ttp`/`ttclid`) feed the **Meta and
TikTok** server-side hits; `_ga` is only needed if you ever run GA4 server-side.
