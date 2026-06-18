# Engagement demo — client → server, end to end

A static page that loads the **real** `whitebox-client` + `whitebox-client-plugin-engagement`,
tracks reading / image dwell / video watching, and streams it to a running whitebox-server.
Use it to exercise the whole path: browser tracker → socket → engagement plugin → awareness.

```
browser (this page)
   │  whitebox-client + engagement plugin
   ▼
serve.mjs  ── static page + esbuild bundle ──┐   same-origin, no CORS
   │  reverse-proxy /sessions /socket.io …    │
   ▼                                          │
whitebox-server (engagement + analytics) ◀────┘
   ▼
awareness store  → channel: web · direction: exposure
```

`serve.mjs` does three things: **starts the whitebox-server** (a child process it manages),
**serves the demo page** (bundling it with esbuild), and **reverse-proxies** API + WebSocket
traffic to the server. The proxy is what makes it work without touching the server: the server has
**no HTTP CORS**, so the browser must reach it same-origin — and through the proxy, it does.

## Prerequisites

1. **Install + build once** (from the repo root):
   ```bash
   npm install
   npm run build --workspace=whitebox-client     # produces whitebox-client/dist
   ```
2. **Redis running locally** and `whitebox-server/.env` filled in (copy from `.env.example`) with
   DB, OpenAI key, and `WB_ENGAGEMENT_TOKEN` / `WB_ANALYTICS_TOKEN`. `whitebox.config.js` must have
   `engagement` + `analytics` in `plugins`.

## Run — one command

```bash
cd examples/engagement
node serve.mjs
# → http://localhost:5173
```

`serve.mjs` **starts the whitebox-server for you** (streaming its logs prefixed `[server]`), waits
for it, then serves the demo. Stopping `serve.mjs` (Ctrl+C) shuts the server down too. Variants:

```bash
WB_START_SERVER=0 node serve.mjs              # don't spawn — use a server you already started
WB_SERVER=http://other-host:3000 node serve.mjs   # proxy to a remote server (never spawns)
```

Open the page, then **scroll slowly**, let your cursor rest on the images, and **play the video**.
Tracked reads appear in the live-events panel on the right as soon as the dwell threshold is crossed.
Reads still in progress when you leave are flushed via `sendBeacon` on unload.

The page has two parts: a short docs section explaining what's tracked, then a **sample patient-education article** ("What actually happens during a root canal") — the kind of post a dental clinic publishes, so you can watch reading depth accumulate on prose people actually read. It also shows the tracker working across more block types: headings, paragraphs, a **pull-quote**, a **bulleted list**, and two images, each tracked as its own block.

## Verify it landed on the server

The header shows the **passport id** (click *copy id*). Query that customer's timeline — the reads
appear as web exposures:

```bash
PASSPORT=<paste-from-header>
TOKEN=<your config.analytics.auth.secret>
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/analytics/timeline/$PASSPORT?channels=web" | jq
```

Or ask a grounded question about the visitor:

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"passport_id\":\"$PASSPORT\",\"question\":\"What did this visitor read about?\"}" \
  "http://localhost:3000/analytics/ask" | jq
```

## Notes

- **The socket is the real path.** The SDK resolves a session over HTTP, then carries the passport
  on the socket handshake; engagement batches flow over `engagement.batch`. (The HTTP `/events`
  fallback needs an explicit `passport_id` and is only used by the unload beacon.)
- **Video triggers server-side transcription** (Whisper + frame vision) of the watched portion on
  first view — that calls OpenAI. To skip it, pass `video: false` to `engagementPlugin({...})` in
  `main.js`.
- **No build step for the demo itself** — `serve.mjs` bundles `main.js` from the workspace packages
  with esbuild on each load. You do need `whitebox-client/dist` built (step 1) because the plugin
  imports the client's built subpath exports.
- Tune responsiveness in `main.js`: `flushIntervalMs` / `batchSize` on the plugin options.
