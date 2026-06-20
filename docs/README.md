# WhiteBox — documentation

A guide to running, configuring, and using WhiteBox, written for the person who
operates and integrates it — not the person who works on its internals.

**WhiteBox is a channel backend with memory.** It records every customer touch —
email, SMS, voice call, web engagement, CRM event, conversion — against one
identity, embeds it into a per-customer semantic store, and lets you ask grounded
questions about it in natural language, over HTTP or MCP.

## The 60-second mental model

1. A visitor becomes a **passport** — one identity that email, phone, login and
   browser fingerprint all merge into.
2. A **session** is a time-boxed visit (with UTMs/referrer) attached to a passport.
3. Every touch is recorded into **awareness**: a row with a `channel`, a
   `direction` (did we reach them, or did they act?), and `text`. The text is
   chunked and embedded so it's semantically searchable.
4. **Channels are plugins** — mail, SMS, voip, engagement, crm, conversions,
   audiences, shortener. Each owns its endpoints and writes to awareness; none
   import each other.
5. You **query** the memory through the core **QUERY** surface — REST `POST /query`,
   `/preview`, `/ask`, `/funnel` and MCP `whitebox.query`, `whitebox.preview`,
   `whitebox.funnel` (a selector engine over both memories) — with the analytics
   plugin (`/analytics/ask`, `recall`, `timeline`) as a higher-level convenience.
   Either way an LLM/agent reads and acts directly over **MCP**.

Your app stays separate and reaches in over HTTP or MCP — it never imports
WhiteBox internals.

## Read in order

1. **[01 · Overview](01-overview.md)** — what WhiteBox is, where it fits, and the
   shape of the system.
2. **[02 · Concepts](02-concepts.md)** — passports & identity merging, sessions,
   the two memories (awareness + facts), the `direction` vocabulary, the selector,
   channels, the context registry.
3. **[03 · Getting started](03-getting-started.md)** — prerequisites, install,
   `.env`, the config file, first run, first requests end-to-end.
4. **[04 · Configuration](04-configuration.md)** — the config factory, every
   top-level key, the plugin pattern, and the full `WB_*` environment reference.
5. **[05 · Awareness & querying](05-awareness-and-querying.md)** — reading the two
   memories: the core QUERY surface (the selector, `/query` · `/preview` · `/ask` ·
   `/funnel`), plus the `/analytics/*` conveniences (`recall`, `population`,
   `timeline`, `ask`).
6. **[06 · MCP](06-mcp.md)** — the `/mcp` endpoint, auth (static token or Auth0),
   connecting a client, and the full tool catalog across plugins.
7. **[07 · Channels](07-channels.md)** — per-channel usage: mail, sms, engagement,
   crm, voip, conversions, audiences, shortener.
8. **[08 · Integrations](08-integrations.md)** — the provider model, the sibling
   integrations repo, the link script, and swapping or adding a provider.
9. **[09 · Deployment](09-deployment.md)** — production setup, webhooks, scaling,
   migrations, and data/GDPR operations.

## Conventions used here

- `WhiteBox` is the product; `whitebox-pro-*` are the npm package / repo / folder
  names (the bare `whitebox` npm name was taken).
- All credentials come from the **environment** (`WB_*`); the config file holds no
  secrets.
- Endpoints are written `METHOD /path`. "Bearer" means
  `Authorization: Bearer <token>` with the plugin's token.
