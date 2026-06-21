# 01 · Architecture

## Components

```
                          whitebox-pro-server-plugin-audiences
 ┌──────────────────────────────────────────────────────────────────────────┐
 │  index.js  (plugin contract: migrate + register)                          │
 │     │ wires everything as init()+singletons                               │
 │     ▼                                                                      │
 │  service.js  ◀── REST (rest.js)        ◀── MCP (mcp.js)                    │
 │     │  the single implementation both transports call                     │
 │     ├──▶ rules.js        zod schema + validation (a saved selector)       │
 │     ├──▶ evaluator.js    thin adapter over ctx.selector (no selection)    │
 │     ├──▶ delivery.js     fire events to adapters, keep-warm               │
 │     │       └─ adapters/{meta,tiktok,google}.js                           │
 │     ├──▶ identity.js     manifest + hashed match keys                     │
 │     ├──▶ consent.js      consent gate + sensitive-category guard          │
 │     └──▶ store.js        knex data access                                 │
 └──────────────────────────────────────────────────────────────────────────┘
        ▲                         ▲                         │
        │ ctx.events              │ ctx.selector (resolve)  │ HTTP
        │ 'awareness.recorded'    │ ctx.ai · ctx.queue       ▼
   WhiteBox core                  WhiteBox core         Meta · TikTok · GA4
```

The plugin no longer does its own selection. The core **selector engine**
(`ctx.selector`, spec at `whitebox-pro-server/docs/selector.md`) owns *all*
selection — `about → filter → judge` over the two memories. The plugin's job is
narrow: **store** a saved selector, **resolve** it through the engine, and
**activate** (deliver) the resulting cohort. `evaluator.js` is now a thin adapter
that maps a rule's source onto the engine; the old bespoke feature families
(`features/semantic.js`, `features/metric.js`, `features/crm.js`) and the LLM
judge are gone — they were a re-implementation of exactly this funnel.

## What the plugin receives from the host (`ctx`)

From `register(app, ctx)` (see `whitebox-pro-server/src/server.js`):

| `ctx.*` | used for |
|---|---|
| `selector` | `resolve()` / `preview()` / `funnel()` / `funnelSlot()` — **all** selection |
| `db` | knex — rules/matches/deliveries/identities + distinct fact keys from `whitebox_facts` |
| `ai` | `object()` for `draft_rule` (the engine owns the judge) |
| `passports` | `identities()` → email/phone for hashed match keys |
| `queue` | `createQueue/createWorker` — debounced dirty-eval |
| `events` | `subscribe('awareness.recorded')` — the dirty-passport trigger |
| `mcp` | `tool()` — register the management tools |
| `scheduler` | keep-warm cron (re-fire sweep) |
| `sessions` | `onResolve()` — attach the identity manifest to session resolve |
| `config` | `config.audiences` block |

## Data flow

### A rule's source

A rule is a **saved core selector**. Its source is *exactly one* of:

- **`select`** — a core selector `{about, filter, judge}` (CRM state lives in
  core facts, reached via `select.filter.fact`).
- **`funnel` + `slot`** — a funnel cohort: a step's completers (`"step:N"`) or a
  gap (`"gap:N→M"`), with an optional `status` of `pending` (still in window) or
  `dropped` (window closed).

### Population evaluate → deliver

The manual run and keep-warm both resolve the *whole* qualified cohort in one
engine call — there's no candidates-then-judge-each double pass.

```
service.evaluateRule(id)
  → evaluator.resolveCohort(rule)
        select  → ctx.selector.resolve(rule.select, { projection: 'people' })
        funnel  → ctx.selector.funnel(...) then funnelSlot(result, slot, { status })
  → for each member: upsert match, then delivery.fireMatch → adapters.sendEvent
        → audit row + stamp fired   (suppressed members are skipped)
```

### Incremental evaluate (dirty-tracking)

```
exposure recorded (web/mail/voip)
  → core publishes 'awareness.recorded'  (already exists — no new publish needed)
  → service.markDirty(passport)
  → enqueue 'audiences-eval' { jobId: passport, delay: debounceMs }   (coalesces)
  → worker → service.evaluatePassport(passport)
        → for each enabled SELECT rule: evaluator.evaluate(rule, passport)
              → ctx.selector.resolve(rule.select, { projection:'people', scope:[passport] })
        → upsert match; if qualified, delivery.fireMatch
```

> **Funnel rules are population-only.** A funnel is inherently a population
> computation, so funnel audiences are skipped on the dirty path and keep warm by
> population re-resolve (`evaluateRule`), never per-passport.

### Keep-warm (Mode A maintenance)

A scheduled sweep re-evaluates still-qualifying matches whose `last_fired_at` is
older than the keep-warm window and re-fires them, so they don't fall out of the
platform's recency window. Drop-offs simply stop being re-fired. See
[02 · Concepts](02-concepts.md).

## Data model

| table | role |
|---|---|
| `whitebox_audience_rules` | rule definitions (`selector` jsonb, or `funnel`+`slot`+`status`, ttl, `policy`, `delivery`) |
| `whitebox_audience_matches` | per (rule, passport) qualification + reason + `fired` map (drives keep-warm + `explain`) |
| `whitebox_audience_deliveries` | append-only audit of every fired event |
| `whitebox_audience_suppression` | hard do-not-target list |
| `whitebox_audience_identities` | browser-collected ad signals per passport (`fbp`, `ttclid`, `ga_client_id`, …) |

Migrations live in [`src/migrations/`](../src/migrations) and run via the plugin's
`migrate(db)` on boot. Migration **007** replaces the legacy `seed`/`criteria`/
`threshold`/`requires` columns with a single `selector` jsonb and drops the old
`whitebox_audience_fact_keys` discovery cache (fact keys now come straight from
core facts). Migration **008** makes `selector` nullable and adds the
`funnel`/`slot`/`status` columns for funnel-sourced audiences. Schema detail per
column is in [09 · API](09-api.md) and the migration files themselves.

## Design rules carried from the core

- **Tap the convergence point, don't couple to plugins.** The plugin subscribes
  to one event (`awareness.recorded`) and reads through `ctx.selector` — it never
  imports another plugin.
- **One engine owns selection.** The plugin stores, resolves, and activates; it
  does not narrow vectors, judge, or aggregate metrics itself.
- **One service, two transports.** REST and MCP are dumb shells over `service.js`.
- **Adapters are data.** Each declares `modes`, `eligible`, `identitySpec`,
  `acceptedKeys` and a `sendEvent` — the core handles consent, hashing, dedup,
  audit, keep-warm.
