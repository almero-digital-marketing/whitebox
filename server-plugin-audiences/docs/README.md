# Audiences plugin — documentation

Everything you need to take this from a scaffold to a working integration.

## Read in order

1. **[01 · Architecture](01-architecture.md)** — the components, the data flow, and the data model.
2. **[02 · Concepts](02-concepts.md)** — Mode A vs Mode B, why "matches" aren't "membership", and the
   two rule sources (a core `select` selector vs a `funnel` slot).
3. **[03 · Rules](03-rules.md)** — the rule schema (a saved selector or a funnel slot), authoring, and
   lifecycle.
4. **[04 · Evaluator](04-evaluator.md)** — how the evaluator is a thin adapter over the core selector
   engine: resolve a cohort (population) or one passport (incremental), preview, and draft.
5. **[05 · Networks](05-networks.md)** — the adapter contract and Mode A per network, plus per-network
   setup: [Meta](networks/meta.md) · [TikTok](networks/tiktok.md) · [Google / GA4](networks/google-ga4.md).
6. **[06 · Identity](06-identity.md)** — the client-collection manifest, the capture shim, hashing,
   and how match keys are resolved.
7. **[07 · CRM integration](07-crm-integration.md)** — CRM state as **core facts**, queried via
   `select.filter.fact`, and how that reaches the selector engine.
8. **[08 · Consent & privacy](08-consent-privacy.md)** — consent gating, PII hashing, the
   sensitive-category guard, and the GDPR audit trail.
9. **[09 · API](09-api.md)** — the full REST + MCP reference and the two-tier auth model.
10. **[10 · Deployment](10-deployment.md)** — config, env vars, the queue, scheduling, and migrations.

## The 60-second mental model

- You write a **rule** — a saved core **selector** (`about / filter / judge`) or a **funnel** slot
  (`step:N` / `gap:N→M`) — or draft it by talking to the MCP tools.
- The core **selector engine** resolves the rule's qualified cohort; the plugin's **evaluator** is a
  thin adapter that calls it (whole cohort for population, one passport for the dirty path).
- A qualified passport becomes a **match** (with a reason).
- **Delivery** fires the rule's custom **event** to each network; the **platform** builds the audience.
- WhiteBox **keeps it warm** (re-fires) and can **explain** every match. It does *not* hold the roster.

## Conventions in this codebase

- Modules use `init(deps)` + free named exports (module singletons), matching the WhiteBox core.
- One **service layer** ([`src/service.js`](../src/service.js)); REST and MCP are thin transports over it.
- Adapters are **data + two methods** — declare constraints, fire an event. Add a network = add an
  adapter + a `docs/networks/*.md`.
