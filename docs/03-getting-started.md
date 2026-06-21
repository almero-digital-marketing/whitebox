# 03 · Getting started

This walks from a clone to a running server answering a question about a customer.

## Prerequisites

- **Node.js** 20+ and npm.
- **PostgreSQL** 14+ with the **pgvector** extension available
  (`CREATE EXTENSION IF NOT EXISTS vector;` — WhiteBox's migrations enable it, but
  the extension must be installed on the server).
- **Redis** 6+ (BullMQ background workers).
- An **OpenAI API key** (embeddings, and the LLM behind `ask`).

## 1. Install

```bash
git clone <your whitebox-pro repo> whitebox-pro
cd whitebox-pro
npm install          # also runs scripts/link-integrations.sh (postinstall)
```

### Integrations (providers)

Providers — Mailgun, Postmark, Twilio, Mobica, the ad networks, Auth0 — live in
**their own repos** in a sibling folder (`../whitebox-pro-integrations/`), outside
this tree. You only need the ones you'll use. Clone them next to the monorepo and
link them in:

```bash
git clone <provider repo> ../whitebox-pro-integrations/whitebox-pro-mail-mailgun
npm run link:integrations     # symlinks present integrations into node_modules
```

The link step is a no-op when the folder is absent — a clone with no integrations
builds and tests fine; you only need them when your config imports a provider. See
[08 · Integrations](08-integrations.md).

## 2. Configure the environment

All secrets come from the environment. Create `server/.env` (it is
gitignored) with at least:

```bash
# Database
WB_DB_HOST=localhost
WB_DB_PORT=5432
WB_DB_NAME=whitebox
WB_DB_USER=whitebox
WB_DB_PASSWORD=...

# Redis
WB_REDIS_HOST=localhost
WB_REDIS_PORT=6379

# AI (embeddings + ask)
WB_OPENAI_API_KEY=sk-...

# Per-plugin bearer tokens (any you enable)
WB_ANALYTICS_TOKEN=...
WB_MCP_TOKEN=...
```

The full list is in [04 · Configuration](04-configuration.md#environment-reference).

## 3. Write the config

The server reads `whitebox.config.js` from its working directory. Copy the example
and trim it to the channels you want:

```bash
cp server/whitebox.config.example.js server/whitebox.config.js
```

The default export is an `async (runtime) => ({ … })` factory. A minimal config:

```js
import { analytics } from 'whitebox-pro-server-plugin-analytics'

export default async () => ({
  port: Number(process.env.WB_PORT || 3000),
  db:    { host: process.env.WB_DB_HOST, port: 5432, database: process.env.WB_DB_NAME,
           user: process.env.WB_DB_USER, password: process.env.WB_DB_PASSWORD },
  redis: { host: process.env.WB_REDIS_HOST, port: 6379 },
  ai:    { apiKey: process.env.WB_OPENAI_API_KEY },
  mcp:   { path: '/mcp', auth: process.env.WB_MCP_TOKEN },
  plugins: [
    analytics({ auth: { secret: process.env.WB_ANALYTICS_TOKEN } }),
  ].filter(Boolean),
})
```

`whitebox.config.js` is **gitignored** — it's where your live, possibly-private
wiring lives. The tracked `whitebox.config.example.js` is the reference.

## 4. Run

```bash
cd whitebox-pro-server
npm start            # node --env-file-if-exists=.env src/server.js
# or, with reload:
npm run dev
```

On boot the server runs each plugin's migrations, then mounts its routes. Check
health:

```bash
curl localhost:3000/health           # { "db": "ok", "redis": "ok" }
```

## 5. First requests end-to-end

**Open a session / mint a passport** (what the browser SDK does at load):

```bash
curl -s -X POST localhost:3000/sessions/resolve \
  -H 'content-type: application/json' \
  -d '{ "utms": { "utm_source": "newsletter" } }'
# → { "passportId": "…uuid…", "sessionId": 1 }
```

**Record a touch.** In practice a channel does this — e.g. enable the `crm` plugin
and post a fact, or the `mail` plugin and send an email. A CRM fact is the simplest:

```bash
curl -s -X POST localhost:3000/crm/facts \
  -H "authorization: Bearer $WB_CRM_TOKEN" -H 'content-type: application/json' \
  -d '{ "source":"app", "customer":{ "email":"ada@example.com" },
        "facts":[{ "id":"n1", "kind":"note", "body":"Asked about enterprise SSO pricing." }] }'
```

**Ask about the customer** (grounded answer over their memory):

```bash
curl -s -X POST localhost:3000/analytics/ask \
  -H "authorization: Bearer $WB_ANALYTICS_TOKEN" -H 'content-type: application/json' \
  -d '{ "passport_id":"…uuid…", "question":"What is this customer interested in?" }'
# → { "answer": "...", "citations": [ … ] }
```

That's the whole loop: **identify → record → ask**. Everything else is more
channels feeding the same memory, and reading it back over HTTP or
[MCP](06-mcp.md).

Next: **[04 · Configuration](04-configuration.md)**.
