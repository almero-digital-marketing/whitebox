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
| `POST` | `/rules/:id/preview` | `{sample?}` | candidate pool, est matches, est cost, requires, sample reasons |
| `POST` | `/rules/:id/evaluate` | `{dryRun=true}` | `{evaluated, matched, fired, suppressed}` |
| `GET` | `/rules/:id/members` | `?limit&offset` | `{count, sample[]}` (privacy-gated) |
| `GET` | `/rules/:id/stats` | | `{qualified}` |

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
| `audiences_preview_rule` ★ | dry-run: pool, matches, reasons, cost, requires |
| `audiences_create_rule` | commit a rule |
| `audiences_enable_rule` | enable / disable |
| `audiences_evaluate` | run now; **`dryRun` defaults true** |
| `audiences_suppress` | do-not-target a passport |

### Write safety
- `audiences_evaluate` and any firing default to **dry-run** — the agent must pass `dryRun:false`.
- `audiences_create_rule` should be preceded by `audiences_preview_rule` (the model's own loop).
- Member listing returns **count + sample**, never a bulk export. Full export is a deliberate,
  separately-gated operation (not exposed by default).
