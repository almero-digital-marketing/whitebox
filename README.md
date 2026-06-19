<p align="center">
  <img src="whitebox.svg" alt="WhiteBox" width="320" />
</p>

# WhiteBox

**WhiteBox is a channel backend with memory.** Record every customer touch — email, voice call, web engagement, CRM event — against one identity, embed it into a per-customer semantic store, and ask grounded questions about it in natural language.

## Where it fits

WhiteBox is a focused component, not your whole backend. It owns customer touchpoints and the memory of them: defined surface, channel-shaped responsibilities. Your app code lives separately and reaches in through HTTP or MCP — it never imports WhiteBox internals.

## Why WhiteBox

- **One identity across channels.** Email, phone, fingerprint and login all merge into a single **passport**, so a call, a click and a reply belong to the same person.
- **Memory you can query.** Every touch is embedded into an **awareness** store. Identical content embeds once (`content_hash`) and is shared across customers at query time — `/analytics/ask` answers in natural language, grounded in what actually happened.
- **LLM-native.** The same data is reachable over **MCP**, so an agent can read timelines, recall context, and act through WhiteBox's tools directly.
- **Channels are plugins.** Each channel is its own npm package that registers against the core `ctx`. Plugins never import each other; adding a channel is a new package, not a core change.

## Channels

This is a monorepo (npm workspaces) — each package publishes independently.

### Server · Node.js · Express · BullMQ · Postgres + pgvector

| package | what it does |
|---|---|
| [`whitebox-server`](whitebox-server) | Core: HTTP server, awareness, passports, sessions, MCP, plugin loader |
| [`whitebox-server-plugin-mail`](whitebox-server-plugin-mail) | Outbound (transactional + bulk), inbound (form + provider webhook), tracking, suppressions — pluggable provider |
| [`whitebox-server-plugin-voip`](whitebox-server-plugin-voip) | Asterisk ARI observer, recording, Whisper transcription, trackable-number pool |
| [`whitebox-server-plugin-crm`](whitebox-server-plugin-crm) | Webhook ingestion of records + facts from external systems |
| [`whitebox-server-plugin-engagement`](whitebox-server-plugin-engagement) | Text / image / video engagement fed into awareness |
| [`whitebox-server-plugin-analytics`](whitebox-server-plugin-analytics) | Recall, population, timeline, grounded `ask`, context inspection |

### Client · browser SDK · tsup · vitest

| package | what it does |
|---|---|
| [`whitebox-client`](whitebox-client) | Core: transport, identity, consent, event emitter, plugin host |
| [`whitebox-client-plugin-mail`](whitebox-client-plugin-mail) | Contact-form submission |
| [`whitebox-client-plugin-voip`](whitebox-client-plugin-voip) | Trackable phone-number swap-in |
| [`whitebox-client-plugin-engagement`](whitebox-client-plugin-engagement) | Reading / viewing / watching trackers |
| [`whitebox-client-plugin-conversions`](whitebox-client-plugin-conversions) | Conversion events |

## Integrations

Third-party adapters live in **their own repos**, not this monorepo. Each is a self-contained package that composes into config like a plugin — ad networks (Meta/Google/TikTok Conversions APIs + pixels), mail providers (Mailgun/Postmark), and MCP auth providers (Auth0 and other OAuth resource-server verifiers):

| package | composes into | what it does |
|---|---|---|
| `whitebox-adnetworks-meta` · `-google` · `-tiktok` | `conversions({ networks: […] })` | server CAPI fan-out (`.`) + browser pixel (`/client`), deduped by `event_id` |
| `whitebox-mail-mailgun` · `whitebox-mail-postmark` | `mail({ provider: … })` | send + transport, inbound/tracking webhook parsing, webhook signature verification |
| `whitebox-server-auth-auth0` | `mcp: { auth: auth0({…}) }` | JWT/OAuth verifier for the `/mcp` endpoint + RFC 9728 discovery |

The shared kernel [`whitebox-adnetworks`](whitebox-adnetworks) (zod schemas, canonical events, identity helpers), the mail plugin's provider seam, and the pluggable MCP auth seam in [`whitebox-server`](whitebox-server) stay in-tree; only the provider specifics live outside.

To develop against them, clone each into `./integrations` — the `integrations/*` workspace glob links them locally, and the folder is gitignored so the monorepo tracks none of their source:

```bash
git clone <integration-repo> integrations/whitebox-adnetworks-meta
npm install          # the integrations/* glob picks up whatever is present
```

> A clone with an empty `integrations/` builds and tests fine — only the example configs that import a provider need it present. Use `npm install` (not `npm ci`) after adding integrations, since the lockfile reflects whatever is linked.

## Develop

```bash
npm install          # one install wires every workspace (no npm link)
npm test             # run all package suites
npm test --workspace=whitebox-server-plugin-mail   # one package
```

Tests spin up a throwaway Neon branch per run — copy `.env.test.example` to `.env.test` and fill in your Neon credentials. Server runtime config lives in `whitebox-server/whitebox.config.js` (copy from `whitebox.config.example.js`). Both are gitignored — never commit real secrets.

## License

UNLICENSED — © Almero Digital Marketing.
