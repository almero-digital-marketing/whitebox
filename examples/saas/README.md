# SaaS integration demo

A pretend SaaS app (**Acme Cloud**) that integrates the **whole WhiteBox client surface** in one page. This is the kitchen-sink example — as new client plugins ship, they get wired in here.

What it exercises today:

| surface | in the demo |
|---|---|
| **core** | session/passport resolution, socket transport, `consent` | header pills + the consent banner |
| **`whitebox-client-plugin-engagement`** | reading / image-dwell tracking | the marketing/pricing copy at the top |
| **`whitebox-client-plugin-crm`** | client observations of in-app usage | the "Simulate product usage" buttons |

One passport, one timeline — marketing reads and in-app product events land in the **same per-customer memory**.

## Prerequisites

1. Build the client once (from the repo root):
   ```bash
   npm install
   npm run build --workspace=whitebox-client
   ```
2. **Redis running** and `whitebox-server/.env` filled in (copy `.env.example`).
3. The server config (`whitebox-server/whitebox.config.js`) must load the plugins this demo uses, and the `crm` plugin needs an auth token (it won't register without one):
   ```js
   plugins: ['engagement', 'crm', 'analytics'],
   crm: { auth: { secret: process.env.WB_CRM_TOKEN } },   // set WB_CRM_TOKEN in .env
   ```

## Run — one command

```bash
cd examples/saas
node serve.mjs            # starts whitebox-server too, then serves on :5173
```

`serve.mjs` starts the server for you (logs prefixed `[server]`), bundles `main.js` with esbuild, and proxies API + WebSocket same-origin. Open the URL it prints.

## Try it

1. **Read** the pricing copy — scroll and pause; paragraphs get a green marker and a `text`/`image` row appears in the live panel (engagement).
2. **Accept** the consent banner — grants `analytics` + `marketing`.
3. **Click the product buttons** — each fires `wb.crm.observe(...)` (a `crm` row). Before consent they're dropped with a warning; after, they send. These are **low-trust observations** tagged `source:'client'`, not authoritative state.
4. Click a log row to expand its full payload.

## Verify on the server

Copy the passport id (header → *copy id*), then ask a grounded question that spans both channels:

```bash
PASSPORT=<paste>
TOKEN=<your config.analytics.auth.secret>
curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"passport_id\":\"$PASSPORT\",\"question\":\"What has this user read and done in the app?\"}" \
  http://localhost:3000/analytics/ask | jq
```

The answer should weave together what they **read** on the marketing page (exposures) and what they **did** in the app (client observations).

## Adding a plugin later

When a new client plugin ships: add it to `plugins: [...]` in `main.js`, surface a small UI affordance for it in `index.html`, and log its events in the one events-wiring block in `main.js`. Keep this example the canonical "everything wired" reference.
