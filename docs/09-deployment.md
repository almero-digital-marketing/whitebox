# 09 · Deployment

What to know to run WhiteBox in production.

## Process & dependencies

WhiteBox is a single Node process (`whitebox-pro-server`) plus its backing
services:

- **PostgreSQL + pgvector** — the system of record and the vector store. Size it
  for your awareness volume; the vector (HNSW) index is the memory-hungry part.
- **Redis** — BullMQ queues for outbound send, embedding, transcription, and the
  outbound webhook worker. If Redis is down, sends queue and retry; nothing is lost.
- **OpenAI** — embeddings and the `ask` LLM (plus Whisper/Vision for voip/engagement).

Run it with a process manager (systemd, PM2, a container orchestrator). The server
binds `WB_PORT`. Front it with TLS (reverse proxy) — webhooks and MCP must be
HTTPS.

```bash
cd whitebox-pro-server
npm start            # node --env-file-if-exists=.env src/server.js
```

## Migrations

Each plugin owns its migrations and runs them at boot (before its routes mount), so
a normal deploy is "ship the new code and restart." No separate migrate step is
required. Plan deploys so the database role used by `WB_DB_USER` can create/alter
its tables and enable the `vector` extension.

## Webhooks

Several channels receive provider callbacks. Expose these publicly over HTTPS and
configure them in each provider's dashboard:

| channel | inbound path(s) | verified by |
|---|---|---|
| mail | `/mail/webhooks/inbox`, `/mail/webhooks/tracking` | provider signature (e.g. Mailgun signing key) |
| sms | `/sms/webhooks/:provider/inbound`, `/sms/webhooks/:provider/status` | provider signature (Twilio) / secret (Mobica DLR) |
| voip | (none — connects out to Asterisk ARI) | — |

Provider webhooks are authenticated by the provider's own signature, not a bearer
token. Point each provider at your host; see the provider READMEs for exact setup.

### Mobica DLR with multiple instances

Mobica allows only one DLR callback URL per account. If several WhiteBox instances
share one Mobica account, fan that single URL out to every instance (e.g. nginx
`mirror`) and give each instance a distinct `instanceId` so its message ids are
globally unique — each instance acts only on its own messages. See the
`whitebox-pro-sms-mobica` README.

## Scaling

- **Vertical first.** One process handles a lot; the workers are I/O-bound (DB,
  Redis, OpenAI).
- **Horizontal.** You can run multiple instances behind a load balancer sharing the
  same Postgres + Redis. BullMQ coordinates workers across instances, and passport
  merges use a distributed lock, so duplicate work is avoided. Watch for the
  multi-instance webhook caveats above (Mobica DLR fan-out).
- **Embedding throughput** is governed by `awareness` concurrency settings and your
  OpenAI rate limits; raise both together.

## MCP in production

Put `/mcp` behind real auth — a static `WB_MCP_TOKEN` for server-to-server, or
`auth0(...)` so human/agent clients log in via OAuth (this also serves the RFC 9728
discovery document). See [06 · MCP](06-mcp.md). Never expose `/mcp` unauthenticated
outside development.

## Secrets

Everything sensitive is an environment variable (`WB_*`), loaded from
`server/.env` (gitignored) or your orchestrator's secret store. The
tracked config files contain no secrets. `whitebox.config.js` (your live wiring) is
also gitignored. Rotate provider tokens through the environment; no code change is
needed.

## Data & GDPR

- **Forget a person:** `DELETE /analytics/passport/:passport_id` deletes all their
  awareness exposures and garbage-collects now-orphaned chunks. Irreversible.
- **PII redaction** is on by default before text is embedded (configurable under
  `awareness.pii`).
- **Opt-out** is enforced at the channel: mail suppressions, SMS STOP/START,
  audiences consent gating + suppression list. Suppressed recipients are blocked at
  send time.
- **Consent** gates browser-side collection (engagement/conversions/audiences) by
  category before anything is sent.

## Health & observability

- `GET /health` → `{ db, redis }`, `503` if either is unreachable — wire it to your
  load balancer / uptime check.
- Structured logs via the configured `logger.level`; set `transport: null` in
  production for JSON logs.
- Notify topics (`mail.*`, `sms.*`, `voip.*`, …) flow through the outbound webhook
  worker — subscribe your own monitoring/dashboards to them.

---

That's the operator's tour. For channel-by-channel depth, follow the links in
[07 · Channels](07-channels.md) into each package's README; for the read/query
surface see [05 · Awareness & querying](05-awareness-and-querying.md); for agents
see [06 · MCP](06-mcp.md).
