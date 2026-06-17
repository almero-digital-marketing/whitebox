# Dental clinic integration demo

A pretend dental clinic site (**Brightsmile Dental**) that integrates the **whole WhiteBox client surface** in one page. This is the kitchen-sink example — as new client plugins ship, they get wired in here.

What it exercises today:

| surface | in the demo |
|---|---|
| **core** | session/passport resolution, socket transport, `consent` | header pills + the consent banner |
| **`whitebox-client-plugin-engagement`** | reading / image-dwell tracking | the service copy: pricing/insurance, cosmetic/whitening, orthodontics/Invisalign, implants/restorative |
| **`whitebox-client-plugin-crm`** | client observations of patient-portal actions | the "Simulate patient actions" buttons (registration, appointment, insurance, whitening, treatment plans, payment plans, emergency, referral, accept treatment) |
| **`whitebox-client-plugin-voip`** | per-visitor call-tracking number (DNI) | the "Call the clinic" card + callback form |

One passport, one timeline — website reads and patient-portal actions land in the **same per-patient memory**.

## Prerequisites

1. Build the client once (from the repo root):
   ```bash
   npm install
   npm run build --workspace=whitebox-client
   ```
2. **Redis running** and `whitebox-server/.env` filled in (copy `.env.example`).
3. The server config (`whitebox-server/whitebox.config.js`) must load the plugins this demo uses, and the `crm` plugin needs an auth token (it won't register without one):
   ```js
   plugins: ['engagement', 'crm', 'analytics', 'voip'],
   crm: { auth: { secret: process.env.WB_CRM_TOKEN } },   // set WB_CRM_TOKEN in .env
   ```

## Run — one command

```bash
cd examples/integration
node serve.mjs            # starts whitebox-server too, then serves on :5273
```

`serve.mjs` starts the server for you (logs prefixed `[server]`), bundles `main.js` with esbuild, and proxies API + WebSocket same-origin. Open the URL it prints.

## Try it

1. **Read** the service copy — scroll and pause; paragraphs get a green marker and a `text`/`image` row appears in the live panel (engagement).
2. **Accept** the consent banner — grants `analytics` + `marketing`.
3. **Click the patient-portal buttons** — each fires `wb.crm.observe(...)` (a `crm` row). Before consent they're dropped with a warning; after, they send. These are **low-trust observations** tagged `source:'client'`, not authoritative state.
4. Click a log row to expand its full payload.

## Seed a whole customer base

One browser session is one passport — so the [console](../console)'s **All customers** / cohort / population questions have nothing to aggregate. `seed.mjs` fixes that: it creates synthetic patients across a handful of personas (whitening-cosmetic, invisalign-ortho, implant-restorative, new-patient-checkup, emergency-pain), driving the **same ingress the browser uses** — `/sessions/resolve`, `/engagement/events`, `/crm/observe`, and a real `voip.pick → /voip/calls` for clinic-call transcripts. Everything is embedded by the running server, so semantic recall/population actually matches.

```bash
cd examples/integration
node serve.mjs &                 # (or have whitebox-server up on :3000)
node seed.mjs                    # ~30 patients
COUNT=60 node seed.mjs           # more
```

Give embeddings a few seconds, then open the console's **All customers** tab and ask *"What treatments are patients most interested in?"* or run a cohort on *"teeth whitening"* / *"dental implants"*. The personas read the service copy (whitening, Invisalign, implants, pricing/insurance) and fire matching CRM observations, so cohorts and themes are real.

### Reset (start clean)

To wipe the seeded data and start over — e.g. after changing the theme, or to drop a mixed base:

```bash
node examples/integration/reset.mjs    # TRUNCATE awareness exposures + chunks
node examples/integration/seed.mjs     # repopulate
```

`reset.mjs` reads the DB config straight from `whitebox-server/.env`, so no `--env-file` is needed. It's **destructive** — it clears *all* awareness content (every passport's reads / observations / calls) on that DB, so only point it at a demo/dev database. (The server can keep running; the seed re-embeds through it.)

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
