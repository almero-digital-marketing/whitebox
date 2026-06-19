# 03 · Rules

A rule is **declarative data** — the schema is in [`src/rules.js`](../src/rules.js) (zod-validated).

## Shape

```js
{
  id: 'enterprise_ready',          // snake_case, stable, primary key
  name: 'Enterprise-ready accounts',
  enabled: true,

  seed: 'usage limit, seats, SSO, SAML, SCIM, audit log, SLA, advanced security',
  criteria: 'Shows scale/limit pressure AND interest in enterprise-grade security or controls',
  threshold: 0.7,                  // min AI confidence (0..1) to qualify
  ttl_days: 30,                    // re-confirm window; set to your audience's lookback
  policy: 'non_sensitive',         // 'non_sensitive' | 'unrestricted'

  requires: {
    semantic: ['enterprise security interest'],
    metric:   [{ content: 'advanced-features', metric: 'distinct_sessions', gte: 2 }],
    crm:      ['seat_limit', 'plan_tier'],
  },

  delivery: {                      // one entry per target network (Mode A)
    meta:   { event: 'wb_enterprise_ready' },
    tiktok: { event: 'wb_enterprise_ready' },
    google: { event: 'wb_enterprise_ready' },
  },
}
```

## Field reference

| field | meaning |
|---|---|
| `seed` | short text the **semantic vector-narrow** searches on. Comma-separated topics work best. |
| `criteria` | one precise sentence the **LLM judges** against. Be specific — it's the rule. |
| `threshold` | qualify only if the judge's `score ≥ threshold`. Higher = stricter, smaller, more precise. |
| `ttl_days` | how stale a match can be before keep-warm re-confirms it. Keep `< platform window`. |
| `policy` | `non_sensitive` runs the sensitive-category guard ([08](08-consent-privacy.md)). |
| `requires` | which feature families to assemble + the hard gates (see below). |
| `delivery` | per-network event name. **Pick a distinct event name per segment** (see [05](05-networks.md)). |

## `requires` — the contract that keeps you honest

Each family is both *"assemble this evidence"* and *"these are the hard constraints."*

### `requires.metric` — deterministic gates (run before the LLM)

```js
{ content: 'pricing',          // content_id LIKE %pricing% (omit/'*' for all)
  metric: 'distinct_sessions', // 'count' | 'distinct_sessions' | 'sum_dwell_ms' | 'recency_days'
  gte: 2, lte: 30,             // bounds (either/both)
  channel: 'web' }            // optional: restrict to a channel
```

- `count` — number of matching exposures.
- `distinct_sessions` — across how many sessions.
- `sum_dwell_ms` — total attention (web engagement carries `dwell_ms`).
- `recency_days` — days since the most recent matching exposure (use `gte` for "gone quiet",
  `lte` for "recently active").

If any metric gate fails, the passport is rejected **without an LLM call**.

### `requires.crm` — required facts

A list of fact keys that must be present (and non-null) for the passport. If a required fact is
**missing for the tenant**, `preview` warns and the rule under-matches — see
[07 · CRM integration](07-crm-integration.md).

### `requires.semantic` — topical anchors

Human-readable topical signals the judge should look for. (The actual recall uses `seed`; this is
documentation for the judge + your future self.)

## Authoring

Three ways, all hitting the same validation:

1. **Talk to it** — `audiences_draft_rule { description }` → a structured draft → `preview` → refine →
   `create`. (See the README conversations.)
2. **REST** — `POST /audiences/rules`.
3. **Config-as-code** — keep rule JSON in your repo and `POST` it on deploy.

**Always `preview` before `create`/`evaluate`.** Preview tells you candidate pool, projected matches,
sample reasons, estimated cost, and `requires` availability — before a cent of LLM or ad spend.

## Lifecycle

```
draft → preview → create(enabled:false) → preview again → enable
   ↓ live: awareness.recorded → debounced evaluate → fire → keep-warm (weekly)
   ↓ decay: stops qualifying → stop firing → platform ages out
delete → stops all evaluation/firing for the rule (matches cascade-deleted)
```

No versioning in v1 (rows carry `updated_at`/`updated_by` only). Treat a rule change as immediate.
