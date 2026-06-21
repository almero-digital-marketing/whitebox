# 03 · Rules

A rule is **declarative data** — the schema is in [`src/rules.js`](../src/rules.js) (zod-validated).

A rule is a **saved core selector** (or a funnel slot) plus delivery + lifecycle. The engine
(`ctx.selector`) does all the selection; this plugin just stores the selector, resolves it, and
activates the cohort. The selector grammar — `about` / `filter` / `judge`, and the full `filter`
boolean tree — lives in [`selector.md`](../../whitebox-pro-server/docs/selector.md); this page is the
audience-rule envelope around it.

## Shape

A rule has **exactly one source**: a `select` (a selector) **or** a `funnel` + `slot`.

```js
{
  id: 'churn_risk',                // snake_case, stable, primary key
  name: 'Pro accounts at churn risk',
  enabled: true,

  // SOURCE A — a core selector (≥1 of about / filter / judge)
  select: {
    about:  'competitor, alternatives, switching',          // semantic narrow (vector)
    filter: { all: [ { fact:   { plan_tier: { eq: 'pro' } } },
                     { metric: { content: 'pricing', channel: 'web', recency_days: { lte: 30 } } } ] },
    judge:  { criteria: 'genuinely at risk of churning', confidence: 0.7 },
  },

  ttl_days: 30,                    // re-confirm window; set to your audience's lookback
  policy: 'non_sensitive',         // 'non_sensitive' | 'unrestricted'

  delivery: {                      // one entry per target network (Mode A)
    meta:   { event: 'wb_churn_risk' },
    tiktok: { event: 'wb_churn_risk' },
    google: { event: 'wb_churn_risk' },
  },
}
```

## Field reference

| field | meaning |
|---|---|
| `select` | a **core selector** — `{ about?, filter?, judge? }`, at least one present. Resolved by the engine. See [`selector.md`](../../whitebox-pro-server/docs/selector.md). |
| `funnel` / `slot` / `status` | the other source — a funnel cohort (a step's completers or a gap). See [Funnel source](#funnel-source). |
| `ttl_days` | how stale a match can be before keep-warm re-confirms it. Keep `< platform window`. Default `30`. |
| `policy` | `non_sensitive` runs the sensitive-category guard ([08](08-consent-privacy.md)). `'non_sensitive'` \| `'unrestricted'`. |
| `delivery` | per-network event name (`meta` / `tiktok` / `google`). **Pick a distinct event name per segment** (see [05](05-networks.md)). |

## `select` — the selector source

`select` is a core selector with three optional stages; **at least one** must be present (an empty
selector would mean "everyone," never what an audience wants):

- **`about`** — a short semantic topic, vector-matched. For a people cohort it *gates* at a similarity
  floor (kept everyone above it), not a top-N. Comma-separated topics work best.
- **`filter`** — a boolean tree (`all` / `any` / `not`) of deterministic `fact` and `metric` clauses,
  run before the LLM. **The grammar is in [`selector.md` §5](../../whitebox-pro-server/docs/selector.md)** —
  `fact` (ops `eq/ne/in/gt/gte/lt/present`, directional dates `next/last/before`, temporal
  `changed/transition/decreased/increased`) and `metric` (windowed aggregates over awareness:
  `count` · `distinct_sessions` · `sum_dwell_ms` · `sum` · `recency_days`, with `content` / `channel` /
  `last`). Don't re-document it here — link to it.
- **`judge`** — `{ criteria, confidence? }`, an LLM predicate run **last**, once per candidate that
  survives `about` + `filter`. `criteria` is one precise sentence; keep if `score ≥ confidence`.

Examples — each is a valid `select`:

```js
// pure structured, NO LLM — win-back (pure-negative; preview flags a full scan)
select: { filter: { all: [ { fact: { order_count: { gte: 1 } } },
                           { not: { metric: { content: 'purchase', recency_days: { lte: 90 } } } } ] } }

// semantic only — interested in teeth whitening
select: { about: 'teeth whitening, whitening cost' }

// windowed spend — big spenders this quarter
select: { filter: { metric: { content: 'purchase', sum: { field: 'value', gte: 1000 }, last: '90d' } } }
```

## Funnel source

The other source is a **funnel** + a **slot** — for windowed / ordered steps (*"started a trial, then
purchased within 14 days"*) that a single `filter` can't express. The funnel shape and resolution are
defined in [`selector.md` §14](../../whitebox-pro-server/docs/selector.md); a rule pins it to one cohort
with `slot`:

```js
{
  id: 'trial_no_purchase',
  name: 'Activated, did not purchase in time',
  enabled: false,

  funnel: {
    within: '30d',                                   // OPTIONAL total window from entry
    steps: [
      { select: { filter: { metric: { content: 'trial_start', count: {} } } }, name: 'trial' },
      { select: { filter: { metric: { content: 'activation', count: {} } } }, within: '7d', name: 'activated' },
      { select: { filter: { metric: { content: 'purchase',   count: {} } } }, within: '14d', name: 'purchased' },
    ],
  },
  slot:   'gap:2→3',               // the drop-off cohort: activated, didn't purchase
  status: 'pending',              // still inside the window (act now) — vs 'dropped' (window closed)

  ttl_days: 30,
  policy: 'non_sensitive',
  delivery: { meta: { event: 'wb_trial_no_purchase' } },
}
```

- **`slot`** — `"step:N"` (that step's completers) or `"gap:N→M"` (the drop-off between two steps).
- **`status`** — only on a `gap:` slot: `'pending'` (did step *k*, hasn't done *k+1*, **still in the
  window** — the higher-value, save-them-now case) or `'dropped'` (window **closed** — win-back).
  The gap is the retargeting payoff, and it **self-drains** via keep-warm as people convert.

## Validation — exactly one source

`src/rules.js` enforces (strict schema — unknown fields are **rejected**):

- **`select` XOR `funnel`** — a rule needs exactly one source.
- A `funnel` source **requires a `slot`** (`"step:N"` or `"gap:N→M"`).
- `status` only applies to a **`gap:` slot**.
- A `select` must have **≥1 of** `about` / `filter` / `judge`.
- `id` is snake_case; `slot` matches `^(step:\d+|gap:\d+→\d+)$`.

> **Migration from the legacy schema.** The old `seed` / `criteria` / `threshold` / `requires` fields
> are **gone** — the strict schema rejects them. They map to the selector as:
> `seed → select.about`, `criteria → select.judge.criteria`, `threshold → select.judge.confidence`,
> `requires.metric → select.filter.metric`, `requires.crm → select.filter.fact`.

## Authoring

Three ways, all hitting the same validation:

1. **Talk to it** — `audiences_draft_rule { description }` → a structured draft → `preview` → refine →
   `create`. (See the README conversations.)
2. **REST** — `POST /audiences/rules`.
3. **Config-as-code** — keep rule JSON in your repo and `POST` it on deploy.

**Always `preview` before `create`/`evaluate`.** Preview runs the selector engine and tells you the
candidate pool, projected matches, sampled judge reasons, whether a full scan is needed, and whether a
confirm is required — before a cent of LLM or ad spend. See [09 · API](09-api.md#preview) for the
response shape.

## Lifecycle

```
draft → preview → create(enabled:false) → preview again → enable
   ↓ live: awareness.recorded → debounced evaluate → fire → keep-warm (weekly)
   ↓ decay: stops qualifying → stop firing → platform ages out
delete → stops all evaluation/firing for the rule (matches cascade-deleted)
```

> Funnel rules are **population-only** — they keep warm via `evaluate`, not the per-passport dirty path
> (incremental eval runs `select` rules only).

No versioning in v1 (rows carry `updated_at`/`updated_by` only). Treat a rule change as immediate.
