# 04 · Configuration

WhiteBox is configured by one file — `whitebox.config.js` in the server's working
directory — plus environment variables for every secret.

## The config factory

The default export is an `async (runtime) => ({ … })` function. It returns the
runtime config object. Because it's a function, you can branch on the environment,
read files, or compute values:

```js
export default async (runtime) => ({
  port, logger, db, redis, webhooks, ai, passports, mcp, plugins,
})
```

`runtime` carries `{ argv, env }`. A plain object export also works (legacy), but
the factory form is preferred.

## Top-level keys

| key | required | what it is |
|---|---|---|
| `port` | yes | HTTP listen port (e.g. `Number(process.env.WB_PORT || 3000)`) |
| `db` | yes | Postgres: `{ host, port, database, user, password }` (pgvector required) |
| `redis` | yes | Redis: `{ host, port, password?, db? }` (BullMQ) |
| `ai` | for embeddings/ask | `{ apiKey }` — the OpenAI key |
| `mcp` | for MCP | `{ path, auth }` — see [MCP](06-mcp.md) |
| `plugins` | yes | array of **built** plugin objects (see below) |
| `logger` | no | `{ level, transport }` — level is `trace…fatal`; `transport: null` disables pretty-print in prod |
| `webhooks` | no | outbound webhook worker: `{ concurrency, retries, timeout }` |
| `passports` | no | `{ lifespans: { fingerprint, phone, email } }` in **days** (merge freshness) |
| `awareness` | no | embedding/redaction tuning (model, chunk size, PII redaction, concurrency) |

## The plugin pattern

`plugins` is an array of objects returned by **calling** each plugin factory with
its options — right there in the config. There is no separate config block to keep
in sync; the factory arguments *are* the plugin's config.

```js
import { analytics } from 'whitebox-pro-server-plugin-analytics'
import { mail }      from 'whitebox-pro-server-plugin-mail'
import { mailgun }   from 'whitebox-pro-mail-mailgun'

plugins: [
  analytics({ auth: { secret: process.env.WB_ANALYTICS_TOKEN } }),

  // Conditionally enable: the && short-circuits to false, and .filter(Boolean)
  // drops it — so mail only mounts when its key is present.
  process.env.WB_MAILGUN_API_KEY && mail({
    company: 'team@example.com',
    provider: mailgun({ apiKey: process.env.WB_MAILGUN_API_KEY, domain: '…' }),
    auth: { secret: process.env.WB_MAIL_TOKEN },
  }),
].filter(Boolean)
```

**Providers compose the same way.** A channel that talks to the outside world
(mail, sms, conversions) takes a provider (or array of networks) built by its own
factory — `mail({ provider: mailgun({…}) })`, `sms({ provider: twilio({…}) })`,
`conversions({ networks: [meta({…})] })`. See [Integrations](08-integrations.md).

Each plugin's full option set is documented in [07 · Channels](07-channels.md) and
in the plugin's own README.

## Auth model

Every privileged endpoint is protected by a **bearer token** you set per plugin
(`auth: { secret: process.env.WB_<PLUGIN>_TOKEN }`), checked with a constant-time
comparison. Public ingress endpoints (browser-facing: `/sessions/resolve`,
`/conversions/events`, `/engagement/events`, `/crm/observe`) and provider webhooks
(verified by the provider's own signature) are unauthenticated by bearer. The
`/mcp` endpoint has its own pluggable auth — [see MCP](06-mcp.md).

## Environment reference

All secrets and connection details come from `process.env` (loaded from
`server/.env` via `--env-file-if-exists`). The config file itself
holds no secrets.

### Core

| var | default | purpose |
|---|---|---|
| `WB_PORT` | 3000 | HTTP port |
| `WB_LOG_LEVEL` | info | `trace`/`debug`/`info`/`warn`/`error`/`fatal` |
| `WB_DB_HOST` `WB_DB_PORT` `WB_DB_NAME` `WB_DB_USER` `WB_DB_PASSWORD` | localhost/5432/whitebox/whitebox/"" | Postgres |
| `WB_REDIS_HOST` `WB_REDIS_PORT` `WB_REDIS_PASSWORD` | localhost/6379/— | Redis |
| `WB_OPENAI_API_KEY` | — | OpenAI (embeddings, ask, Whisper/Vision) |
| `WB_MCP_TOKEN` | — | bearer for `/mcp` (when using a static token) |

### Per-plugin bearer tokens

| var | plugin |
|---|---|
| `WB_ANALYTICS_TOKEN` | analytics |
| `WB_ENGAGEMENT_TOKEN` | engagement (cache admin) |
| `WB_CRM_TOKEN` | crm |
| `WB_CONVERSIONS_TOKEN` | conversions (audit endpoint) |
| `WB_SHORTENER_TOKEN` | shortener |
| `WB_MAIL_TOKEN` | mail |
| `WB_SMS_TOKEN` | sms |
| `WB_AUDIENCES_TOKEN` | audiences |

### Shortener

| var | purpose |
|---|---|
| `WB_SHORTENER_BASEURL` | public host for short links (its hostname gates the `/:code` redirect) |

### Mail providers

| var | provider |
|---|---|
| `WB_MAILGUN_API_KEY` `WB_MAILGUN_DOMAIN` `WB_MAILGUN_WEBHOOK_SIGNING_KEY` | Mailgun |
| `WB_POSTMARK_SERVER_TOKEN` `WB_POSTMARK_FROM` `WB_POSTMARK_WEBHOOK_USER` `WB_POSTMARK_WEBHOOK_PASSWORD` | Postmark |

### SMS providers

| var | provider |
|---|---|
| `WB_TWILIO_SID` `WB_TWILIO_TOKEN` `WB_TWILIO_FROM` | Twilio |
| `WB_MOBICA_USER` `WB_MOBICA_PASS` `WB_MOBICA_DLR_SECRET` | Mobica |

### Ad networks (conversions / audiences)

| var | network |
|---|---|
| `WB_META_PIXEL_ID` `WB_META_CAPI_TOKEN` `WB_META_TEST_EVENT_CODE` | Meta |
| `WB_TIKTOK_PIXEL_CODE` `WB_TIKTOK_EVENTS_TOKEN` | TikTok |
| `WB_GA4_MEASUREMENT_ID` `WB_GA4_API_SECRET` | Google GA4 |

### VoIP & MCP auth

| var | purpose |
|---|---|
| `WB_ARI_URL` `WB_ARI_USER` `WB_ARI_PASSWORD` | Asterisk ARI connection |
| `AUTH0_DOMAIN` (+ `audience`/`scope` set inline) | Auth0 verifier for `/mcp` |

> A given deployment only needs the variables for the plugins and providers it
> actually enables.

Next: **[05 · Awareness & querying](05-awareness-and-querying.md)**.
