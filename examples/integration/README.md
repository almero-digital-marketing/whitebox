# Dental clinic integration demo

A pretend dental clinic site (**Brightsmile Dental**) that integrates the **whole WhiteBox client surface** in one page. This is the kitchen-sink example — as new client plugins ship, they get wired in here.

What it exercises today:

| surface | in the demo |
|---|---|
| **core** | session/passport resolution, socket transport, `consent` | header pills + the consent banner |
| **`whitebox-pro-client-plugin-engagement`** | reading / image-dwell tracking + **link-click intent** | the service copy (pricing/insurance, cosmetic/whitening, orthodontics/Invisalign, implants/restorative) and the *Learn more* CTAs (`data-wb-link`) |
| **`whitebox-pro-client-plugin-crm`** | client observations of patient-portal actions | the "Simulate patient actions" buttons (registration, appointment, insurance, whitening, treatment plans, payment plans, emergency, referral, accept treatment) |
| **`whitebox-pro-client-plugin-voip`** | per-visitor call-tracking number (DNI) | the "Call the clinic" card + callback form |
| **`whitebox-pro-client-plugin-conversions`** | standard conversion events → ad-network pixels (Meta/TikTok/GA4) **+** server SST, deduped by `event_id` | the "Fire standard events" card |

One passport, one timeline — website reads and patient-portal actions land in the **same per-patient memory**.

## Prerequisites

1. Build the client once (from the repo root):
   ```bash
   npm install
   npm run build --workspace=whitebox-pro-client
   ```
2. **Redis running** and `server/.env` filled in (copy `.env.example`).
3. The server config (`server/whitebox.config.js`) must load the plugins this demo uses. Plugins are factories called with their options (`crm` needs an auth token or it won't register):
   ```js
   import { engagement } from 'whitebox-pro-server-plugin-engagement'
   import { crm } from 'whitebox-pro-server-plugin-crm'
   import { analytics } from 'whitebox-pro-server-plugin-analytics'
   import { voip } from 'whitebox-pro-server-plugin-voip'
   import { conversions } from 'whitebox-pro-server-plugin-conversions'
   // …
   plugins: [
     engagement({ auth: { secret: process.env.WB_ENGAGEMENT_TOKEN } }),
     crm({ auth: { secret: process.env.WB_CRM_TOKEN } }),   // set WB_CRM_TOKEN in .env
     analytics({ auth: { secret: process.env.WB_ANALYTICS_TOKEN } }),
     voip({ /* … */ }),
     conversions({ /* networks: [meta({…}), …] for ad-network fan-out — see below */ }),
   ]
   ```
   `conversions` works with no options (records server-side, fires client pixels); add a `networks` block to fan out to the ad networks — see [Conversion tracking → ad networks](#conversion-tracking--ad-networks).

## Run — one command

```bash
cd examples/integration
node serve.mjs            # starts whitebox-pro-server too, then serves on :5273
```

`serve.mjs` starts the server for you (logs prefixed `[server]`), bundles `main.js` with esbuild, and proxies API + WebSocket same-origin. Open the URL it prints.

## Try it

1. **Read** the service copy — scroll and pause; paragraphs get a green marker and a `text`/`image` row appears in the live panel (engagement).
2. **Click a *Learn more* CTA** (under each service) — a `link` row appears. A click is a **strong intent signal**, recorded as a web *expression*; the generic ones carry a `data-wb-link` label (so "Learn more" under implants becomes interest in *"dental implant pricing and financing"*).
3. **Accept** the consent banner — grants `analytics` + `marketing`.
4. **Click the patient-portal buttons** — each fires `wb.crm.observe(...)` (a `crm` row). Before consent they're dropped with a warning; after, they send. These are **low-trust observations** tagged `source:'client'`, not authoritative state.
5. **Fire a standard event** (the "Fire standard events" card) — each button calls `wb.conversions.<event>(…)`: it fires the ad pixels present on the page (Meta/TikTok/GA4) **and** POSTs to `/conversions/events` under one shared `event_id`. The `conversion` row shows which pixels fired + the id. Also marketing-consent-gated. To actually reach the ad networks, set the env vars below.
6. Click a log row to expand its full payload.

## Conversion tracking → ad networks

The **Fire standard events** card sends each conversion two ways under one shared `event_id` (so pixel ↔ server-side dedupe):

- **Browser pixels** — `serve.mjs` injects the Meta / GA4 / TikTok base snippets into the page **when their ids are set** (below); the conversions client fires `Purchase`/`ViewContent`/… on whatever's loaded.
- **Server-side (SST)** — the same event POSTs to `/conversions/events`; the server `conversions` plugin records it into awareness and, for each **configured** network, fans out (Meta CAPI / TikTok Events API).

Both read the **same env vars** — set them in `server/.env` (the demo and the server both load it):

| env var | network | used by | what it is |
|---|---|---|---|
| `WB_META_PIXEL_ID` | Meta | client pixel **+** server CAPI | Pixel / dataset id |
| `WB_META_CAPI_TOKEN` | Meta | server CAPI | Conversions API access token |
| `WB_TIKTOK_PIXEL_CODE` | TikTok | client pixel **+** server Events API | Pixel code |
| `WB_TIKTOK_EVENTS_TOKEN` | TikTok | server Events API | Events API access token |
| `WB_GA4_MEASUREMENT_ID` | GA4 | client `gtag` only | Measurement id (`G-…`) |
| `WB_CONVERSIONS_TOKEN` | — | server | Bearer for the `GET /conversions/events` audit endpoint (optional) |
| `WB_OPENAI_API_KEY` | — | server | already required — conversions are embedded into awareness |

> **GA4 is client-side only** here: GA4 has no pixel↔Measurement-Protocol `event_id` dedup, so we fire `gtag` in the browser and **don't** enable the server `google` adapter (it would double-count non-purchase events). Meta and TikTok fire both legs, deduped.

Then make the server fan out: your `server/whitebox.config.js` must include `conversions` with a `networks` block (the committed `whitebox.config.example.js` already has it):

```js
import { meta } from 'whitebox-pro-adnetworks-meta'
import { tiktok } from 'whitebox-pro-adnetworks-tiktok'

conversions({
  auth: { secret: process.env.WB_CONVERSIONS_TOKEN },
  networks: [
    meta({ pixelId: process.env.WB_META_PIXEL_ID, accessToken: process.env.WB_META_CAPI_TOKEN }),
    tiktok({ pixelCode: process.env.WB_TIKTOK_PIXEL_CODE, accessToken: process.env.WB_TIKTOK_EVENTS_TOKEN }),
    // GA4 stays client-side (gtag) — don't compose google() here.
  ],
})
```

**Nothing configured?** It still works — conversions record into awareness server-side and the buttons log locally; only the outbound pixel/CAPI calls are skipped. `serve.mjs` prints which pixels it injected on startup, and a missing pixel is a silent no-op.

**Verify:** with `WB_CONVERSIONS_TOKEN` set, `curl -s -H "Authorization: Bearer $WB_CONVERSIONS_TOKEN" 'http://localhost:3000/conversions/events?limit=10' | jq` shows the audit log with per-network delivery status. Meta and TikTok also have Test Events tools in their dashboards.

## Seed a whole customer base

One browser session is one passport — so the [console](../console)'s **All customers** / cohort / population questions have nothing to aggregate. `seed.mjs` fixes that: it creates synthetic patients across a handful of personas (whitening-cosmetic, invisalign-ortho, implant-restorative, new-patient-checkup, emergency-pain), driving the **same ingress the browser uses** — `/sessions/resolve`, `/engagement/events`, `/crm/observe`, and a real `voip.pick → /voip/calls` for clinic-call transcripts. Everything is embedded by the running server, so semantic recall/population actually matches.

The simplest path is two server flags — no separate seed run, no second terminal:

```bash
cd examples/integration
node serve.mjs --reset --seed    # bring up the demo, wipe, then seed ~30 patients
COUNT=60 node serve.mjs --reset --seed
```

`serve.mjs` forwards the flags to the whitebox-pro-server it starts. **`--reset`** wipes all awareness data on boot; **`--seed`** runs the seed once the server is listening (it spawns `seed.mjs` against itself). Use either alone — `--seed` to add to the current base, `--reset` to clear without reseeding. You can also drive the server directly:

```bash
cd whitebox-pro-server
node --env-file=.env src/server.js --reset --seed
```

Or run the seed by hand against a server that's already up:

```bash
node examples/integration/seed.mjs      # ~30 patients   (COUNT=60 for more)
```

Give embeddings a few seconds, then open the console's **All customers** tab and ask *"What treatments are patients most interested in?"* or run a cohort on *"teeth whitening"* / *"dental implants"*. The personas read the service copy (whitening, Invisalign, implants, pricing/insurance) and fire matching CRM observations, so cohorts and themes are real.

> **`--reset` is destructive** — it clears *all* awareness content (every passport's reads / observations / calls) on whatever DB `server/.env` points at. Demo/dev databases only.

## Verify on the server

Copy the passport id (header → *copy id*), then ask a grounded question that spans both channels:

```bash
PASSPORT=<paste>
TOKEN=<your config.analytics.auth.secret>
curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"passport_id\":\"$PASSPORT\",\"question\":\"What has this patient read and done on the site?\"}" \
  http://localhost:3000/analytics/ask | jq
```

The answer should weave together what they **read** on the clinic website (exposures) and what they **did** in the patient portal (client observations).

## Adding a plugin later

When a new client plugin ships: add it to `plugins: [...]` in `main.js`, surface a small UI affordance for it in `index.html`, and log its events in the one events-wiring block in `main.js`. Keep this example the canonical "everything wired" reference.
