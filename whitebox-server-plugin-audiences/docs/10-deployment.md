# 10 · Deployment

## 1. Install + enable

In this monorepo the package is workspace-linked. Add it to your config's `plugins`:

```js
// whitebox.config.js
plugins: ['engagement', 'analytics', 'audiences']
```

On boot the host calls `plugin.migrate(db)` (creates the `whitebox_audience_*` tables) then
`plugin.register(app, ctx)`.

## 2. Config

Merge [`whitebox.config.example.js`](../whitebox.config.example.js). Key blocks:

```js
mcp:   { path: '/mcp', auth: { secret: process.env.WB_MCP_TOKEN } },   // gates the MCP tools
audiences: {
  auth: { secret: process.env.WB_AUDIENCES_TOKEN },                    // gates REST /audiences/*
  evaluation: { candidateLimit, candidateSimilarity, model, debounceMs, keepWarmDays },
  networks: { meta:{…}, tiktok:{…}, google:{…} },
  privacy:  { requireConsentCategory:'marketing', sensitiveCategories:[…] },
}
```

## 3. Environment variables

All secrets come from `process.env` (keep them out of the repo — a gitignored `.env`).

| var | purpose |
|---|---|
| `WB_MCP_TOKEN` | bearer for `/mcp` (the MCP tools) |
| `WB_AUDIENCES_TOKEN` | bearer for the REST management API |
| `WB_META_PIXEL_ID`, `WB_META_CAPI_TOKEN` | Meta CAPI |
| `WB_TIKTOK_PIXEL_CODE`, `WB_TIKTOK_EVENTS_TOKEN` | TikTok Events API |
| `WB_GA4_MEASUREMENT_ID`, `WB_GA4_API_SECRET` | GA4 Measurement Protocol |

A network is only **eligible** when its vars are set — check `GET /audiences/networks`.

## 4. Infrastructure dependencies

Provided by the WhiteBox host via `ctx` — you don't configure them here, but they must be running:

- **Postgres + pgvector** — awareness embeddings (the `semantic` feature) and the plugin's tables.
- **Redis** — the event bus (`awareness.recorded` dirty trigger) and BullMQ (debounced eval +
  keep-warm).
- **OpenAI (or your AI SDK provider)** — the judge + `draft_rule`. Set `evaluation.model`.

## 5. Background processing

- **Dirty-eval worker:** `audiences-eval` queue. `markDirty(passport)` enqueues with
  `jobId = eval:<passport>` + `delay = debounceMs`, so bursts of exposures coalesce into one eval.
- **Keep-warm sweep:** wired to `ctx.scheduler` (daily). Re-fires still-qualifying matches older than
  `keepWarmDays`. **Verify your host's scheduler API** — the scaffold calls `scheduler.every('1d', …)`;
  adapt to your scheduler (cron, BullMQ repeatable job, etc.).

## 6. Per-segment platform step (manual, once)

For each segment, create the Custom Audience on each network keyed on the event name, with a lookback
window ≥ `keepWarmDays`. See [05 · Networks](05-networks.md) and the per-network docs.

## 7. Client capture shim

Scaffold `whitebox-client-plugin-ads-capture` separately (see [06 · Identity](06-identity.md)) and add
it to the browser SDK's `plugins`. It reads the manifest and posts collected ad signals to
`POST /audiences/identity`. Without it, server CAPI/Events have weaker match rates and GA4 has no
`client_id`.

## 8. Production checklist

- [ ] `WB_AUDIENCES_TOKEN` and `WB_MCP_TOKEN` set (no open management surface).
- [ ] Consent wired (`passports.hasConsent`) and `requireConsentCategory` set — see [08](08-consent-privacy.md).
- [ ] Sensitive-category guard upgraded from the keyword stub.
- [ ] `estCost()` constant set to your real model price (so `preview` cost is meaningful).
- [ ] Judge switched to structured output (`generateObject`) — see [04](04-evaluator.md).
- [ ] Keep-warm scheduler verified against your host.
- [ ] Per-network audiences created with the right lookback window.
- [ ] Deliveries audit-log retention policy set.

## 9. Verify end-to-end

```bash
# networks eligible?
curl -s localhost:3000/audiences/networks -H "authorization: Bearer $WB_AUDIENCES_TOKEN"
# what CRM facts do we have?
curl -s localhost:3000/audiences/facts -H "authorization: Bearer $WB_AUDIENCES_TOKEN"
# draft → preview → (dry) evaluate, without firing
curl -s -X POST localhost:3000/audiences/draft -H "authorization: Bearer $WB_AUDIENCES_TOKEN" \
  -H 'content-type: application/json' -d '{"description":"enterprise-ready accounts"}'
```

Then use Meta Test Events / GA4 DebugView to confirm events arrive **before** creating the audiences.
