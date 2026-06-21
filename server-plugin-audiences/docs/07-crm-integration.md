# 07 · CRM integration

Audiences gate on **state** (`plan_tier`, `seat_count`, `mrr`, subscription status, …) the same way
they gate on anything else: through the selector's `filter`. The hard question — *"how do you
integrate with a CRM you don't know in advance?"* — is answered entirely in core, not here.

## CRM state is core facts

The CRM plugin **owns no store of its own.** It's a thin, identity-keyed webhook adapter: whatever
your CRM pushes lands in one of the two core memories, and audiences query that — there is no
audiences-side CRM machinery.

```
   ANY CRM (Salesforce / HubSpot / Stripe / Pipedrive / custom)
        │  native webhook · Zapier/Make/n8n · iPaaS · a 3-line script
        ▼
   POST /crm/records  (structured state)   POST /crm/facts  (free-text notes)
        │  identity resolution → passport (mint or match)
        ▼                                  ▼
   core FACTS (ctx.facts)              core AWARENESS (semantic)
   typed key→value, timestamped        notes, tags, call summaries
        │                                  │
        ▼                                  ▼
   select.filter.fact { … }           select.about / judge evidence
```

Two webhooks, two memories — and audiences read each through a different part of the selector:

- **Structured state → core facts → `filter.fact`.** `POST /crm/records` writes a record's `status`
  and each scalar in `data` into the core **facts** memory (`ctx.facts`), keyed by `kind`. Facts are
  append-only, so a status change just appends a new row; the current value is the latest and the
  history powers `asOf` time-travel and temporal operators.
- **Notes → awareness → `about` / `judge`.** `POST /crm/facts` ingests *free-text things we know* —
  a staff note, a tag, a call summary — into **awareness** (`channel: 'crm'`,
  `direction: 'observation'`). They become searchable semantic memory, reachable via a selector's
  `about` and citable as evidence the `judge` weighs.

That's the whole split: **typed, value-queryable state is a fact; free text is a note.** You never
re-merge the two streams, and audiences never special-case the CRM.

## Targeting CRM state — `filter.fact`

Because structured state is core facts, the core selector engine filters on it directly — no
CRM-specific query path. A `fact` clause is `{ fact: { <key>: { <op>: <value> } } }`:

```js
// Pro accounts who haven't cancelled
{ select: {
    filter: { all: [ { fact: { plan_tier:    { eq: "pro" } } },
                     { fact: { subscription: { ne: "cancelled" } } } ] } },
  delivery: { meta: { event: "wb_pro_active" } } }
```

The `key` is the record's `kind` (for its `status`) or a scalar field name from `data`. Ops are
`eq` / `ne` / `in` / `gt` / `lt` / `present`, directional dates `next` / `last` / `before`, and the
temporal operators `changed` / `transition` / `decreased` / `increased`.

The temporal ones are the CRM payoff — they read the fact's history, not just its current value:

```js
// Just-churned: subscription transitioned INTO "cancelled"
{ select: {
    filter: { fact: { subscription: { transition: { to: "cancelled" } } } } },
  delivery: { meta: { event: "wb_just_churned" } } }
```

And `fact` composes with the rest of the selector — pair it with `about` and a `judge` for nuance,
where the CRM **notes** in awareness become the evidence the judge reads:

```js
// Pro accounts genuinely evaluating a competitor (notes inform the judge)
{ select: {
    about:  "competitor, alternatives, switching",
    filter: { fact: { plan_tier: { eq: "pro" } } },
    judge:  { criteria: "seriously evaluating a switch", confidence: 0.7 } } }
```

## Discovery

To author from what's *actually* flowing rather than a guess, ask the base which fact keys exist —
read straight from core facts (no per-plugin cache):

```
GET /audiences/facts
→ [ { key: "plan_tier" }, { key: "subscription" }, { key: "seat_count" }, { key: "mrr" } ]
```

## Typing and freshness

- **Typed at the source.** A scalar arrives as a number, bool, date, or string and is stored as
  that type, so `{ fact: { mrr: { gt: 500 } } }` and date comparisons work. Non-scalar `data` fields
  aren't value-queryable (flatten upstream if you need to filter on them).
- **Freshness.** Facts are timestamped (the record's `starts_at` is the fact's `observed_at`). The
  current value is the latest write; use `asOf` to read a past state, and `last` / `before` windows
  to gate on recency. Stale state is a real risk for ad targeting — prefer recent facts.

## The one gap to wire

`awareness.recorded` fires on content exposures (web / mail / voip) but **not** on a CRM-state-only
update. So a passport whose only new signal is a fresh CRM fact won't be re-evaluated by the dirty
trigger. Options:

- have the CRM ingestion **also** publish a dirty signal the audiences plugin subscribes to, or
- rely on the **keep-warm / scheduled sweep** to re-evaluate periodically (good enough for
  slow-moving CRM state like plan tier).
