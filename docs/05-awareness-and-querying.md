# 05 · Awareness & querying

WhiteBox has **two core memories** you read back: **awareness** (semantic,
unstructured — recall, population, embeddings) and **facts** (structured,
append-only, typed — plan, MRR, status, with `asOf` time-travel). See
[Concepts](02-concepts.md#facts--the-structured-memory) for the memories
themselves; this chapter is about **reading** them.

There are two layers to query with, and you'll mostly want the first:

1. **Core QUERY** (the primary path) — a single query language, the **selector**,
   over *both* memories. It lives in **core**, not a plugin: apps and agents
   resolve a selector directly against core, exposed as REST (`POST /query`,
   `/preview`, `/ask`, `/funnel`) and MCP. Channel-agnostic, and the same predicate
   analytics and audiences both speak.
2. **Analytics conveniences** (`/analytics/*`) — higher-level, awareness-only
   endpoints (`ask`, `recall`, `population`, `timeline`) for the common
   "summarize / search one customer" jobs. Each is now a friendly caller of the
   core engine.

(How records get *written* is covered per channel in
[07 · Channels](07-channels.md); the awareness record shape is in
[Concepts](02-concepts.md#awareness).)

---

## Core QUERY — the selector

The selector is the single predicate "who / what," resolved into a **projection**.

```js
selector = { about?, filter?, judge? }   // all three optional
```

- **`about`** — a semantic topic (vector over awareness). For **knowledge** it
  *ranks* evidence best-first; for **people** it *gates* — everyone above a
  similarity floor, never "the top N."
- **`filter`** — a boolean tree of deterministic clauses, no LLM:
  - `fact` — a typed gate over the **facts** timeline:
    `{ fact: { plan_tier: { eq: "pro" } } }`. Ops: `present` · `eq` · `ne` · `in` ·
    `gt` · `gte` · `lt` · `lte`, directional dates `next` / `last` / `before`, and
    temporal `changed` / `transition` / `decreased` / `increased`.
  - `metric` — a **windowed aggregate** over the awareness event stream:
    `{ metric: { content: "purchase", sum: { field: "value", gte: 500 }, last: "30d" } }`.
    Aggregates: `count` · `distinct_sessions` · `sum_dwell_ms` · `recency_days` ·
    `sum`; `last` is the lookback window.
  - Composed with `{ all: […] }` / `{ any: […] }` / `{ not: … }`.
  - The rule of thumb: a *lifetime / current / source-authoritative* attribute is a
    **fact**; an *"in the last N days"* aggregate is a **metric**.
- **`judge`** — an optional LLM membership predicate for nuance the deterministic
  stages can't express: `{ criteria: "genuinely at risk of churning", confidence: 0.7 }`.
  It runs **last**, once per candidate that survived `about` + `filter`, and returns
  `{ match, score }`. It decides *who's in* — it never writes prose.

Resolution is a funnel — cheap stages narrow before the expensive one: `about`
(vector) → `filter` (SQL over facts + awareness) → `judge` (LLM, per survivor). So
the judge's cost is governed by how much `about` + `filter` narrowed first.

### Projections

The engine **retrieves data — it never writes prose.** Two projections:

| projection | returns | scope |
|---|---|---|
| `people` | a cohort: `{ count, passports: [{ id, why, score, matched_at }] }` | base only |
| `knowledge` | ranked content / evidence (chunks) | a passport or the whole base |

`asOf` time-travels the deterministic part (both memories roll back together). A
`people` projection saved with a delivery attached **is an audience** (see
[audiences](07-channels.md#audiences)).

### REST

All four endpoints are mounted by **core** (not the analytics plugin) and auth-gated.

```
POST /query
{ "selector": { "about": "competitor, switching, cancel",
                "filter": { "all": [ { "fact": { "plan_tier": { "eq": "pro" } } },
                                     { "fact": { "subscription_status": { "ne": "cancelled" } } } ] },
                "judge":  { "criteria": "genuinely at risk of churning", "confidence": 0.7 } },
  "projection": "people" }
→ { "count": 120, "passports": [ { "id": "…", "why": "…", "score": 0.83, "matched_at": "…" }, … ] }
```

Request fields: `selector`, `projection` (`people` | `knowledge`), `scope`
(`"passport"`, or a passport-id array as a candidate set), `passport`
(knowledge·passport), `asOf`, `limit`, and `group` (see below).

A knowledge query against one passport — "what do we know about Jane re: pricing?":

```
POST /query
{ "selector": { "about": "pricing, plans" },
  "projection": "knowledge", "scope": "passport", "passport": "p1" }
```

### preview — the cost gate before a judge run

The judge is the only expensive stage. **`POST /preview`** makes its cost visible
*before* you run or save — cheap, no full judge run:

```
POST /preview
{ "selector": { … }, "projection": "people" }
→ the about-cohort size, the filter survivors (= exactly the judge-call count),
  a full-scan flag when the filter has no positive anchor, and — when a judge is
  present — a sampled qualifying rate + projected match count + a few real reasons.
  `confirmRequired` is set when survivors exceed the safety cap.
```

Always preview a judged `people` query first, so the judge never sweeps an
unbounded set by accident. Request fields: `selector`, `projection` (`people`),
`scope`, `asOf`.

### group — time-series & breakdown charts

Pass **`group: { by: "<bucket>" }`** on a `/query` to get a **series** instead of a
single result — it buckets the selector's `metric`/`count` aggregate and returns
`[{ bucket, value }]`. Bucket by a time grain (`hour` / `day` / `week` / `month`)
or a dimension (`channel` / `direction` / `source` / `content`):

```
POST /query
{ "selector": { "filter": { "metric": { "content": "purchase", "count": {} } } },
  "projection": "knowledge", "group": { "by": "week" } }
→ [ { "bucket": "2026-W10", "value": 42 }, { "bucket": "2026-W11", "value": 51 }, … ]
```

This is the one engine capability charts add; trend and breakdown dashboards are
built on it.

### funnel — ordered, windowed steps

Most funnels are just a selector (`{ all: [A, { not: B }] }` is "did A, not B").
The case that needs machinery is **windowed, ordered** steps — *"started a trial,
then purchased within 14 days **of starting**."* **`POST /funnel`** takes ordered
steps, each resolved against the prior step's survivors and joined on `matched_at`
(step *k* keeps only those whose event is *after* step *k-1*'s and within
`step.within`; the anchor advances):

```
POST /funnel
{ "funnel": { "within": "30d",
              "steps": [ { "select": "trialStarted" },
                         { "select": "activated", "within": "7d" },
                         { "select": "purchased", "within": "14d" } ] },
  "named": { "trialStarted": { … }, "activated": { … }, "purchased": { … } } }
```

It returns a **drop-off report** (per-step count + conversion, a `knowledge`
projection) plus per-step cohorts (`step:N`) and **gap cohorts** (`gap:N→M`, split
into `pending` = window still open vs `dropped` = window closed, a `people`
projection). The gap cohorts are the retargeting payoff — save them as audiences.
Windowed steps must be deterministic (event/fact, which carries the `matched_at`);
`about` / `judge` steps only work as un-windowed membership. Request fields:
`funnel` (`within?`, `steps[]` of `{ select, within? }`), `named`, `asOf`.

### ask — a natural-language answer (REST only)

**`POST /ask`** is a thin layer *above* the engine: it resolves a `knowledge`
query, then has the LLM **synthesize** a grounded answer over the returned
evidence. Answering is *generation*, so it lives above the retrieval engine, never
inside it.

```
POST /ask
{ "question": "Has this customer asked about pricing?", "passport": "p1" }
→ { "answer": "…", … }
```

Request fields: `question`, an optional `selector` (extra `about` / `filter`
narrowing; `about` defaults to the question), `scope`, `passport`, `asOf`, `limit`.

There is deliberately **no MCP `/ask`** — an MCP client is already an LLM agent, so
it queries `knowledge` and synthesizes the answer in its own context. See
[MCP](06-mcp.md).

---

## Analytics conveniences (`/analytics/*`)

The endpoints below are the higher-level, awareness-focused convenience layer,
mounted by `whitebox-pro-server-plugin-analytics` and requiring
`Authorization: Bearer $WB_ANALYTICS_TOKEN`. They're the familiar "summarize /
search one customer" jobs; the core QUERY surface above is the primary,
channel-agnostic way to query. Each has an MCP equivalent — see [MCP](06-mcp.md).

## ask — grounded answer about one customer

The convenience wrapper for "summarize this customer." Give a passport and a
natural-language question; WhiteBox recalls the most relevant awareness chunks,
assembles registered context (facts surfaced by the CRM provider, etc.), and has
the LLM answer **grounded in that evidence**, with citations. (The core
[`/ask`](#ask--a-natural-language-answer-rest-only) is the channel-agnostic
equivalent, taking a full selector.)

```
POST /analytics/ask
{ "passport_id": "…", "question": "Has this customer asked about pricing?", "limit": 20 }
→ { "answer": "…", "citations": [ { "text": "…", "channel": "mail", "ts": "…" } ] }
```

Use it for "what does this person care about / has been told / has done."

## ask-population — answer about the whole base (or a cohort)

The same idea across all customers. WhiteBox finds the content matching the
question, weights it by reach, and answers about the population.

```
POST /analytics/ask-population
{ "question": "What are customers most confused about in onboarding?" }
→ { "answer": "…", "citations": [ … ] }
```

## recall — semantic search for one customer

Lower-level than `ask`: returns the ranked awareness chunks themselves (no LLM), so
you can build your own UI or logic on top.

```
POST /analytics/recall
{ "passport_id": "…", "query": "refund policy", "limit": 10, "min_similarity": 0.2 }
→ { data: [ { chunk_text, similarity, channel, direction, source, ts, … } ], limit, offset, has_more }
```

Ranking blends vector similarity with engagement depth (a fully-read paragraph
outranks a skimmed heading).

## population — cohort sizing

"How many customers match this idea?" Returns distinct passport count plus the
matching passports and their hits.

```
POST /analytics/population
{ "query": "interested in enterprise SSO", "similarity": 0.75, "min_engagement": 0 }
→ { count: 137, passports: [ { passport_id, hits: [ … ] }, … ] }
```

This is the read-side of audience thinking; the [audiences](07-channels.md#audiences)
plugin turns the same matching into ad-platform events. For structured or mixed
(semantic + facts) cohorts, reach for a core `people` query instead.

## timeline — raw chronology

A flat, newest-first list of a passport's exposures, no embedding work. Filter by
channel, direction, and date range.

```
GET /analytics/timeline/:passport_id?channels=mail,voip&directions=expression&from=2026-01-01
→ { data: [ … exposures with session context … ], limit, offset, has_more }
```

Good for an audit trail or a customer-history view.

## context — what the plugins know (debug)

Inspect the **structured** side: what every registered context provider currently
reports for a passport, before the LLM step. Structured CRM state now lives in the
core [facts](02-concepts.md#facts--the-structured-memory) memory, so the CRM
provider surfaces `facts.current`; to query those facts as filters, use a core
`{ filter: { fact: … } }` query. Optionally filter by provider.

```
GET /analytics/context/:passport_id?providers=crm
```

## forget — GDPR deletion

Irreversibly delete all awareness for a passport (and garbage-collect orphaned
chunks).

```
DELETE /analytics/passport/:passport_id
```

See [Deployment → data & GDPR](09-deployment.md#data--gdpr).

## Pagination

Collection endpoints return a consistent envelope:

```json
{ "data": [ … ], "limit": 50, "offset": 0, "has_more": true }
```

Pass `?limit=` and `?offset=` (each endpoint caps `limit`).

## How recall stays cheap and honest

- **Embed once, share everywhere.** Identical content (same `content_hash`) is
  embedded a single time and shared across every customer who saw it, so a
  broadcast email isn't embedded 10,000 times.
- **Engagement-weighted.** A chunk's score is `similarity × (0.4 + 0.6 ×
  engagement)`, where engagement comes from how deeply they actually consumed it —
  so "read to the end" beats "scrolled past."
- **Deduped at query time.** Recall keeps the most recent exposure per chunk, so
  repeated sends of the same content don't flood the results.

Next: **[06 · MCP](06-mcp.md)**.
