# 06 · MCP

WhiteBox exposes its data and actions over the **Model Context Protocol** so an LLM
or agent (Claude, a custom agent, an IDE) can read customer memory and act through
WhiteBox's tools — with the same auth and rules as the HTTP API.

## The endpoint

One endpoint, mounted by the core after all plugins have registered their tools:

```
POST /mcp        (also GET, DELETE — streamable HTTP, stateless)
```

Configured under the top-level `mcp` key:

```js
mcp: {
  path: '/mcp',
  auth: process.env.WB_MCP_TOKEN,   // static bearer token (string), or a composed verifier
}
```

## Authentication

`mcp.auth` is a **pluggable verifier**. Three options:

1. **Static bearer token** — set `auth` to a string (or `{ secret }`). Clients send
   `Authorization: Bearer <token>`. Simplest; good for server-to-server.
2. **Auth0 (OAuth)** — compose the `whitebox-pro-auth-auth0` verifier so MCP clients
   can log in themselves:
   ```js
   import { auth0 } from 'whitebox-pro-auth-auth0'
   mcp: {
     path: '/mcp',
     auth: auth0({ domain: process.env.AUTH0_DOMAIN,
                   audience: 'https://whitebox/mcp', scope: 'mcp:use' }),
   }
   ```
   This also serves `GET /.well-known/oauth-protected-resource` (RFC 9728) so a
   client can discover the authorization server and run the OAuth flow without
   pre-shared secrets.
3. **None** — omit `auth` (development only).

Any OAuth resource-server verifier can be dropped in the same way; Auth0 is just
the first provider package. See [Integrations](08-integrations.md).

## Connecting a client

- **With a static token:** point your MCP client at `https://your-host/mcp` and
  configure the bearer token.
- **With Auth0:** point the client at `https://your-host/mcp`; on a `401` it reads
  the `/.well-known/oauth-protected-resource` metadata, runs the OAuth flow against
  your Auth0 tenant, and retries with the issued token.

The server advertises its tool/resource/prompt catalog on connect.

## Tool catalog

The **core QUERY** tools are always present (core exposes the selector engine
directly); everything else is contributed by the plugins you enable. Naming: the
core query and analytics tools are the headline `whitebox.*` set; each channel
namespaces its own.

### Core QUERY — the selector (from core)

The core query surface over both memories (semantic **awareness** + structured
**facts**), exposed as MCP tools that mirror the REST endpoints in
[05 · Querying](05-awareness-and-querying.md#core-query--the-selector):

| tool | purpose |
|---|---|
| `whitebox.query` | resolve a selector `{ about, filter, judge }` into a projection — `knowledge` (ranked evidence) or `people` (a cohort `{ count, passports }`); `asOf` time-travels, `group: { by }` returns a `[{ bucket, value }]` series for charts |
| `whitebox.preview` | cost-gate a `people` selector *before* running/saving — about-cohort size, filter survivors (= the judge-call count), full-scan flag, and a sampled judge rate when a judge is present |
| `whitebox.funnel` | resolve ordered, windowed steps → a drop-off report plus per-step (`step:N`) and gap (`gap:N→M`, `pending`/`dropped`) cohorts |

> **No MCP `ask` by design.** Answering is *generation*, and an MCP client is
> already an LLM agent — so it queries `whitebox.query` for `knowledge` and
> synthesizes the answer in its own context. The natural-language `/ask` layer is
> REST-only (for non-agent callers like a dashboard); see
> [05 · ask](05-awareness-and-querying.md#ask--a-natural-language-answer-rest-only).
> For a `people` query, run `whitebox.preview` first to see the judge cost.

### Analytics — read & reason (from `analytics`)

The higher-level, awareness-focused conveniences (callers of the core engine):

| tool | purpose |
|---|---|
| `whitebox.ask` | grounded answer about one customer |
| `whitebox.ask_population` | grounded answer about the whole base / a cohort |
| `whitebox.recall` | semantic search of a passport's memory (ranked chunks) |
| `whitebox.population` | count distinct customers matching a query |
| `whitebox.timeline` | flat chronological exposures for a passport |
| `whitebox.context` | inspect structured context providers for a passport |
| `whitebox.forget` | GDPR-delete a passport's awareness |

### Channels — act

| plugin | tools |
|---|---|
| mail | `mail.send` · `mail.outbox_get` · `mail.inbox_list` · `mail.inbox_get` · `mail.suppress` · `mail.unsuppress` |
| sms | `sms.send` · `sms.outbox_get` · `sms.inbox_list` · `sms.suppress` · `sms.unsuppress` |
| crm | `crm.upsert_record` · `crm.add_fact` · `crm.get_state` |
| engagement | `engagement.list_content` · `engagement.get_content` · `engagement.invalidate_content` |
| conversions | `conversions.list_events` |
| shortener | `shortener.create_link` · `shortener.list_links` · `shortener.link_stats` |
| voip | `voip.list_calls` · `voip.get_call` · `voip.get_transcript` |
| audiences | `audiences_list_rules` · `audiences_draft_rule` · `audiences_preview_rule` · `audiences_create_rule` · `audiences_enable_rule` · `audiences_evaluate` · `audiences_explain_match` · `audiences_passport_segments` · `audiences_segment_members` · `audiences_network_status` · `audiences_list_facts` · `audiences_delivery_log` · `audiences_suppress` |

Several plugins also expose read-only **resources** (e.g. recent conversion events,
recent voip calls) for browsing.

## A typical agent flow

1. `whitebox.query` (`knowledge`) — or `whitebox.recall` / `whitebox.timeline` — to
   understand a customer, then synthesize a summary in your own context.
2. `whitebox.query` (`people`, after `whitebox.preview`) to build a cohort over both
   memories, or `whitebox.funnel` for a windowed drop-off.
3. `mail.send` or `sms.send` to follow up — or `audiences_draft_rule` →
   `audiences_preview_rule` → `audiences_create_rule` to activate a segment.

Because tools share the same identity, auth, and awareness as the HTTP API, an
agent acting over MCP is indistinguishable from your app acting over HTTP — every
action it takes is itself recorded.

Next: **[07 · Channels](07-channels.md)**.
