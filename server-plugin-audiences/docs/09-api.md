# 09 · API (REST + MCP) & Auth

REST and MCP are thin transports over one [`service.js`](../src/service.js). Same operations, two
surfaces.

## Auth — two tiers, both bearer

WhiteBox already has the mechanism (`createAuth`, timing-safe `Authorization: Bearer <secret>`); this
plugin reuses the pattern. **No user/identity layer is required for v1** — these are privileged API
keys, rotated like your other secrets.

| tier | who | gated by |
|---|---|---|
| **public / ingest** | browser SDK (sessions, engagement, `/audiences/identity`) | existing client token |
| **management** | admin / UI / scripts (`/audiences/*`) | `audiences.auth.secret` |
| **MCP** | agent / Claude | `config.mcp.auth.secret` (the host already gates `/mcp`) |

> The `/mcp` secret gates *all* MCP tools across plugins (endpoint-level), not per-tool. Fine for v1;
> per-tool scopes are a v2 extension. Per-user tokens + roles wait for a real auth layer.

## REST reference

Base: `/audiences`. All routes require `Authorization: Bearer <audiences.auth.secret>`.

### Rules
| method | path | body / query | returns |
|---|---|---|---|
| `GET` | `/rules` | | all rules |
| `POST` | `/rules` | a rule | the saved rule |
| `GET` | `/rules/:id` | | one rule |
| `PATCH` | `/rules/:id` | partial rule | merged + saved |
| `DELETE` | `/rules/:id` | | `{deleted}` |
| `POST` | `/rules/:id/preview` | `{sample?}` | candidate pool, est matches, sampled reasons, full-scan / confirm flags (see [below](#preview)) |
| `POST` | `/rules/:id/evaluate` | `{dryRun=true}` | `{evaluated, matched, fired, suppressed, dryRun}` |
| `GET` | `/rules/:id/members` | `?limit&offset` | `{count, sample[]}` (privacy-gated) |
| `GET` | `/rules/:id/stats` | | `{rule_id, qualified}` |

#### Rule body (create / PATCH)

A rule is a **saved selector** with exactly one source — `select` **or** `funnel`+`slot`. The full
schema, examples, and validation are in [03 · Rules](03-rules.md); the request body is that object:

```jsonc
// POST /audiences/rules
{
  "id": "churn_risk",
  "name": "Pro accounts at churn risk",
  "enabled": false,
  "select": {
    "about":  "competitor, alternatives, switching",
    "filter": { "all": [ { "fact": { "plan_tier": { "eq": "pro" } } },
                         { "metric": { "content": "pricing", "recency_days": { "lte": 30 } } } ] },
    "judge":  { "criteria": "genuinely at risk of churning", "confidence": 0.7 }
  },
  "ttl_days": 30,
  "policy": "non_sensitive",
  "delivery": { "meta": { "event": "wb_churn_risk" } }
}
```

A funnel source instead carries `funnel` + `slot` (+ optional `status`) — see
[03 · Funnel source](03-rules.md#funnel-source). `POST` returns the saved rule; `PATCH /:id` merges the
partial body onto the existing rule and re-validates.

#### `preview`

`POST /rules/:id/preview` (or pass a full rule body) runs the selector engine — no fire, no LLM beyond
the small judge sample:

```jsonc
{
  "candidate_pool":   1800,        // size after `about` (the similarity-floor cohort)
  "est_matches":      120,         // projected qualifying count
  "sampled":          20,          // judge calls made for the sample
  "full_scan":        false,       // true when there's no positive anchor → walk the whole base
  "confirm_required": false,       // true above the survivor cap → running/saving needs an explicit confirm
  "sample_reasons":   [ "…", "…" ] // a few real "why" reasons from the sample
}
```

For a **funnel** rule, the pool/matches reflect the slot size. (There is no "requires availability" in
the response — the legacy `requires` contract is gone; see [03 · Rules](03-rules.md#validation--exactly-one-source).)

### Passports
| method | path | returns |
|---|---|---|
| `GET` | `/passports/:pid/segments` | rules this passport qualifies for |
| `POST` | `/passports/:pid/evaluate` | evaluate now |
| `POST` / `DELETE` | `/passports/:pid/suppress` | add / remove from do-not-target |

### Networks / discovery / audit
| method | path | returns |
|---|---|---|
| `GET` | `/networks` | adapters: name, modes, eligible, transport |
| `GET` | `/networks/:net/identity-manifest` | the client-collection manifest |
| `GET` | `/facts` | available CRM fact keys (discovery) |
| `GET` | `/deliveries` | `?rule&network&status&limit` — fired-event audit |
| `GET` | `/suppression` | the do-not-target list |
| `POST` | `/draft` | `{description}` → a draft rule |

### Public (ingest tier, NOT management-gated)
| method | path | body |
|---|---|---|
| `POST` | `/audiences/identity` | `{passport_id, signals}` — the client capture shim posts collected ad signals |

> The scaffold's `rest.js` registers the management routes. Wire `/audiences/identity` to
> `service.saveSignals` behind the **public** token (not the management secret).

### `dryRun` default

`POST /rules/:id/evaluate` defaults to `dryRun:true` — pass `{"dryRun": false}` to actually fire.
This is deliberate: evaluation costs LLM money and firing touches ad spend.

## MCP reference

Registered on the shared `/mcp` server (behind `config.mcp.auth.secret`). The AI-native tools
(`draft_rule`, `preview_rule`, `explain_match`) are the high-value ones.

| tool | purpose |
|---|---|
| `audiences_list_rules` / `audiences_get_rule` | inspect rules |
| `audiences_network_status` | networks + eligibility |
| `audiences_list_facts` | available CRM fact keys (discovery) |
| `audiences_passport_segments` | a passport's segments |
| `audiences_segment_members` | count + sample (privacy-gated) |
| `audiences_explain_match` ★ | why a passport qualified — the audit trail |
| `audiences_delivery_log` | recent fired events |
| `audiences_draft_rule` ★ | NL → structured rule draft (no commit) |
| `audiences_preview_rule` ★ | dry-run a rule (or rule id): candidate pool, est matches, sampled reasons, full-scan flag |
| `audiences_create_rule` | commit a rule |
| `audiences_enable_rule` | enable / disable |
| `audiences_evaluate` | run now; **`dryRun` defaults true** |
| `audiences_suppress` | do-not-target a passport |

### Write safety
- `audiences_evaluate` and any firing default to **dry-run** — the agent must pass `dryRun:false`.
- `audiences_create_rule` should be preceded by `audiences_preview_rule` (the model's own loop).
- Member listing returns **count + sample**, never a bulk export. Full export is a deliberate,
  separately-gated operation (not exposed by default).
