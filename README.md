<p align="center">
  <img src="whitebox.svg" alt="WhiteBox" width="320" />
</p>

<p align="center"><strong>The AI-native marketing data brain.</strong></p>

# WhiteBox

**WhiteBox is a channel backend with memory.** Record every customer touch — email, voice call, web engagement, CRM event — against one identity, embed it into a per-customer semantic store, and ask grounded questions about it in natural language.

📖 **[Documentation](docs/)** — operator & integrator guide: [overview](docs/01-overview.md) · [concepts](docs/02-concepts.md) · [getting started](docs/03-getting-started.md) · [configuration](docs/04-configuration.md) · [awareness & querying](docs/05-awareness-and-querying.md) · [MCP](docs/06-mcp.md) · [channels](docs/07-channels.md) · [integrations](docs/08-integrations.md) · [deployment](docs/09-deployment.md).

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
| [`whitebox-pro-server`](whitebox-pro-server) | Core: HTTP server, awareness, passports, sessions, MCP, plugin loader |
| [`whitebox-pro-server-plugin-mail`](whitebox-pro-server-plugin-mail) | Outbound (transactional + bulk), inbound (form + provider webhook), tracking, suppressions — pluggable provider |
| [`whitebox-pro-server-plugin-voip`](whitebox-pro-server-plugin-voip) | Asterisk ARI observer, recording, Whisper transcription, trackable-number pool |
| [`whitebox-pro-server-plugin-crm`](whitebox-pro-server-plugin-crm) | Webhook ingestion of records + facts from external systems |
| [`whitebox-pro-server-plugin-engagement`](whitebox-pro-server-plugin-engagement) | Text / image / video engagement fed into awareness |
| [`whitebox-pro-server-plugin-analytics`](whitebox-pro-server-plugin-analytics) | Recall, population, timeline, grounded `ask`, context inspection |

### Client · browser SDK · tsup · vitest

| package | what it does |
|---|---|
| [`whitebox-pro-client`](whitebox-pro-client) | Core: transport, identity, consent, event emitter, plugin host |
| [`whitebox-pro-client-plugin-mail`](whitebox-pro-client-plugin-mail) | Contact-form submission |
| [`whitebox-pro-client-plugin-voip`](whitebox-pro-client-plugin-voip) | Trackable phone-number swap-in |
| [`whitebox-pro-client-plugin-engagement`](whitebox-pro-client-plugin-engagement) | Reading / viewing / watching trackers |
| [`whitebox-pro-client-plugin-conversions`](whitebox-pro-client-plugin-conversions) | Conversion events |

## Integrations

Third-party adapters live in **their own repos**, not this monorepo. Each is a self-contained package that composes into config like a plugin — ad networks (Meta/Google/TikTok Conversions APIs + pixels), mail providers (Mailgun/Postmark), SMS providers (Twilio/Mobica), and MCP auth providers (Auth0 and other OAuth resource-server verifiers):

| package | composes into | what it does |
|---|---|---|
| `whitebox-pro-adnetworks-meta` · `-google` · `-tiktok` | `conversions({ networks: […] })` | server CAPI fan-out (`.`) + browser pixel (`/client`), deduped by `event_id` |
| `whitebox-pro-mail-mailgun` · `whitebox-pro-mail-postmark` | `mail({ provider: … })` | send + transport, inbound/tracking webhook parsing, webhook signature verification |
| `whitebox-pro-sms-twilio` · `whitebox-pro-sms-mobica` | `sms({ provider: …, routes: {…} })` | send + DLR/inbound webhook parsing, signature verification; routed per destination prefix |
| `whitebox-pro-auth-auth0` | `mcp: { auth: auth0({…}) }` | JWT/OAuth verifier for the `/mcp` endpoint + RFC 9728 discovery |

The shared kernel [`whitebox-pro-adnetworks`](whitebox-pro-adnetworks) (zod schemas, canonical events, identity helpers), the mail and SMS plugins' provider seams, and the pluggable MCP auth seam in [`whitebox-pro-server`](whitebox-pro-server) stay in-tree; only the provider specifics live outside.

Integrations live in a **sibling directory outside the monorepo** (default `../whitebox-pro-integrations/`, override with `WB_INTEGRATIONS_DIR`) so they're never part of the monorepo's working tree or git. Clone the ones you need there, then link them in:

```bash
git clone <integration-repo> ../whitebox-pro-integrations/whitebox-pro-adnetworks-meta
npm install          # `postinstall` runs scripts/link-integrations.sh
# or re-link any time without a full install:
npm run link:integrations
```

`scripts/link-integrations.sh` symlinks each present integration into `node_modules` (bridging the `whitebox-pro-adnetworks` kernel into the ad-network packages, which is their only unpublished dependency). It's idempotent and a no-op when the directory is absent — a clone with no integrations builds and tests fine; only example configs that import a provider need it present.

## Develop

```bash
npm install          # one install wires every workspace (no npm link)
npm test             # run all package suites
npm test --workspace=whitebox-pro-server-plugin-mail   # one package
```

Tests spin up a throwaway Neon branch per run — copy `.env.test.example` to `.env.test` and fill in your Neon credentials. Server runtime config lives in `whitebox-pro-server/whitebox.config.js` (copy from `whitebox.config.example.js`). Both are gitignored — never commit real secrets.

## License

UNLICENSED — © Almero Digital Marketing.
