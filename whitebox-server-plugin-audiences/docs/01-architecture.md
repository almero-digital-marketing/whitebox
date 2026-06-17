# 01 · Architecture

## Components

```
                          whitebox-server-plugin-audiences
 ┌──────────────────────────────────────────────────────────────────────────┐
 │  index.js  (plugin contract: migrate + register)                          │
 │     │ wires everything as init()+singletons                               │
 │     ▼                                                                      │
 │  service.js  ◀── REST (rest.js)        ◀── MCP (mcp.js)                    │
 │     │  the single implementation both transports call                     │
 │     ├──▶ rules.js        zod schema + validation                          │
 │     ├──▶ evaluator.js    vector-narrow → AI-confirm                       │
 │     │       ├─ features/semantic.js  awareness recall + population        │
 │     │       ├─ features/metric.js    SQL aggregates over exposures        │
 │     │       └─ features/crm.js       context.collect facts + discovery    │
 │     ├──▶ delivery.js     fire events to adapters, keep-warm               │
 │     │       └─ adapters/{meta,tiktok,google}.js                           │
 │     ├──▶ identity.js     manifest + hashed match keys                     │
 │     ├──▶ consent.js      consent gate + sensitive-category guard          │
 │     └──▶ store.js        knex data access                                 │
 └──────────────────────────────────────────────────────────────────────────┘
        ▲                         ▲                         │
        │ ctx.events              │ ctx.awareness/context   │ HTTP
        │ 'awareness.recorded'    │ ctx.openai · ctx.queue   ▼
   WhiteBox core                  WhiteBox core         Meta · TikTok · GA4
```

## What the plugin receives from the host (`ctx`)

From `register(app, ctx)` (see `whitebox-server/src/server.js`):

| `ctx.*` | used for |
|---|---|
| `db` | knex — rules/matches/deliveries + metric aggregates over `whitebox_awareness_exposures` |
| `awareness` | `recall()` (per-passport evidence) + `population()` (candidate narrowing) |
| `openai` | `prompt()` for the AI judge + `draft_rule` |
| `context` | `collect()` → generic CRM facts (the `crm` feature) |
| `passports` | `identities()` → email/phone for hashed match keys |
| `queue` | `createQueue/createWorker` — debounced dirty-eval |
| `events` | `subscribe('awareness.recorded')` — the dirty-passport trigger |
| `mcp` | `tool()` — register the management tools |
| `scheduler` | keep-warm cron (re-fire sweep) |
| `config` | `config.audiences` block |

## Data flow

### Ingest → evaluate (dirty-tracking)

```
exposure recorded (web/mail/voip)
  → core publishes 'awareness.recorded'  (already exists — no new publish needed)
  → service.markDirty(passport)
  → enqueue 'audiences-eval' { jobId: passport, delay: debounceMs }   (coalesces)
  → worker → service.evaluatePassport(passport) → per enabled rule: evaluate + fire
```

> **Gap to close:** a CRM-*fact*-only update doesn't emit `awareness.recorded`. Either have the CRM
> ingestion emit its own dirty signal, or rely on the keep-warm/scheduled sweep to pick it up. See
> [07 · CRM integration](07-crm-integration.md).

### Evaluate → deliver

```
candidates = population(seed)                        # cheap vector pass
for each candidate:
   metric gate (SQL) ── fail ──▶ not qualified       # no LLM spend on structural non-matches
   crm gate (facts)  ── fail ──▶ not qualified
   semantic evidence = recall(seed)
   verdict = LLM judge(criteria, evidence, metrics, facts)   # structured {match,score,reason}
   upsert match
   if qualified: delivery.fireMatch → adapters.sendEvent → audit row + stamp fired
```

### Keep-warm (Mode A maintenance)

A scheduled sweep re-evaluates still-qualifying matches whose `last_fired_at` is older than
`keepWarmDays` and re-fires them, so they don't fall out of the platform's recency window. Drop-offs
simply stop being re-fired. See [02 · Concepts](02-concepts.md).

## Data model

| table | role |
|---|---|
| `whitebox_audience_rules` | rule definitions (seed, criteria, threshold, ttl, `requires`, `delivery`) |
| `whitebox_audience_matches` | per (rule, passport) qualification + reason + `fired` map (drives keep-warm + `explain`) |
| `whitebox_audience_deliveries` | append-only audit of every fired event |
| `whitebox_audience_suppression` | hard do-not-target list |
| `whitebox_audience_identities` | browser-collected ad signals per passport (`fbp`, `ttclid`, `ga_client_id`, …) |
| `whitebox_audience_fact_keys` | discovery cache of CRM fact keys seen (for `requires` validation) |

Migrations live in [`src/migrations/`](../src/migrations) and run via the plugin's `migrate(db)` on
boot. Schema detail per column is in [09 · API](09-api.md) and the migration files themselves.

## Design rules carried from the core

- **Tap the convergence point, don't couple to plugins.** The plugin subscribes to one event
  (`awareness.recorded`) and reads `awareness`/`context` — it never imports another plugin.
- **One service, two transports.** REST and MCP are dumb shells over `service.js`.
- **Adapters are data.** Each declares `modes`, `eligible`, `identitySpec`, `acceptedKeys` and a
  `sendEvent` — the core handles consent, hashing, dedup, audit, keep-warm.
