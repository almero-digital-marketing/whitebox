# Analytics Plugin

> The read side of whitebox. Turns the per-passport semantic memory written by mail / voip / engagement / crm into HTTP endpoints — including a single grounded LLM endpoint that can answer almost any natural-language question about one customer.

## What it is

A thin, auth-protected HTTP shell over `core/awareness` and the per-passport context registry. It owns **no data, no embeddings, no domain logic** — it composes three primitives:

1. `core/awareness` — semantic recall, cohort queries, timeline, GDPR forget.
2. `ctx.context` — structured state from other plugins (CRM rows, billing status, …) without analytics ever importing them.
3. `openai.prompt` — grounded synthesis on top of (1) and (2).

Awareness itself has **no public surface** by design. Analytics is the only way to read out of it.

## What you get

- **A grounded Q&A endpoint over the whole customer.** `POST /analytics/ask` returns an LLM answer that combines semantic recall from every channel (mail bodies, call transcripts, watched video segments, web reading, CRM notes) with current-state structured context (active subscription, upcoming reservation), and cites timestamps + UTM attribution from the evidence.
- **Cohort awareness in one call.** `POST /analytics/population` returns "how many distinct customers have seen / said anything matching this concept" with a similarity threshold — the analytics equivalent of "how big is the segment that knows X".
- **A grounded Q&A endpoint over the whole base.** `POST /analytics/ask-population` is the cohort sibling of `/ask`: no passport, it answers population-level questions ("what are customers asking about?", "how big is the cohort that's seen X?") grounded in content from across every passport, weighted by how many customers each piece reached.
- **Per-customer semantic search.** `POST /analytics/recall` returns the top-k chunks from one customer's history scoped by query embedding.
- **A debug surface for the context registry.** `GET /analytics/context/:passport_id` shows exactly what each registered plugin is feeding into `/ask`, with `?provider=` filtering and paging — useful for verifying a new integration before it changes LLM answers.
- **GDPR forget in one call.** `DELETE /analytics/passport/:id` cascades through all channels' awareness footprint.
- **Zero per-channel coupling.** Adding a new channel plugin tomorrow (billing, support tickets, scheduling …) automatically shows up in `/ask` answers — analytics doesn't change.

## How to integrate

### 1. Enable the plugin

```js
// config
{
  plugins: [..., 'analytics'],
  analytics: {
    auth: { secret: process.env.WHITEBOX_ANALYTICS_TOKEN },
  },
}
```

There are no other knobs. All semantic behavior lives in `config.awareness`.

### 2. Ask grounded questions

```js
const res = await fetch('https://wb.example.com/analytics/ask', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${process.env.WHITEBOX_ANALYTICS_TOKEN}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    passport_id: customer.passport_id,
    question: 'Has this customer had any billing issues, and what was their reaction?',
  }),
})

const { answer, evidence, context } = await res.json()
```

`answer` is the synthesized text. `evidence` is the raw chunks the LLM saw (with timestamps, channel, UTM). `context` is the structured state pulled from registered providers (CRM rows, etc.). Surface as much or as little of either to your operators as you want.

### 3. Build on top of the retrieval primitives

For custom synthesis flows that aren't a free-form question, compose the lower-level endpoints yourself:

```js
// "Has this user seen the refund policy in the last 30 days?"
const { hits } = await POST('/analytics/recall', {
  passport_id, query: 'refund policy', limit: 5,
})
const recent = hits.find(h => new Date(h.ts) > thirtyDaysAgo)
```

The pattern that scales: pull grounded evidence, format it with timestamps + attribution, pipe through your own prompt. The four base endpoints (`recall`, `population`, `timeline`, `context`) are the building blocks — `/ask` is one example of stitching them together.

### 4. Let other plugins enrich answers

Any plugin that wants its structured data to influence `/analytics/ask` calls one line in its setup:

```js
ctx.context.register('billing', async (passportId, { limit = 20, offset = 0 } = {}) => {
  return db('subscriptions').where({ passport_id: passportId }).limit(limit).offset(offset)
})
```

That's it. Analytics will collect from that provider on every `/ask` and include the rows in the LLM prompt under `Structured context: billing:`. The CRM plugin's registration is the canonical example.

## Role

```
┌─────────────────────────────────────────┐
│  analytics (this plugin)                │
│  HTTP routes, auth, Zod validation,     │
│  grounded LLM synthesis (/ask)          │
└──────────┬───────────────────┬──────────┘
           │ calls             │ collects from
           ▼                   ▼
┌────────────────────┐  ┌─────────────────────────┐
│ core/awareness     │  │ ctx.context (registry)  │
│ recall / population│  │ crm, billing, …         │
│ timeline / forget  │  │ (whatever plugins join) │
└────────────────────┘  └─────────────────────────┘
```

## File layout

```
src/plugins/analytics/
├── index.js          - HTTP routes, Zod schemas, auth
└── README.md
```

No migrations. No worker. No DB tables. Just routes.

## Endpoints

All four are auth-protected with a Bearer token. None are public.

### Pagination

Every collection endpoint takes the same `limit` + `offset` params (defaults/caps differ per endpoint) and returns the same envelope:

```json
{ "data": [ ... ], "limit": 50, "offset": 0, "has_more": true }
```

`has_more` is computed by fetching one extra row — no `COUNT` query. `population` additionally returns `total` (the cohort size). The one structural exception is `context`: it returns a *map* of providers rather than a single list, so it carries the same `limit`/`offset` params but keeps a per-provider `has_more`.

### `POST /analytics/recall` — per-passport semantic search

> "What does this user know about X?"

Request:
```json
{
  "passport_id": "a1b2c3d4-5678-4abc-89de-1234567890ab",
  "query": "enterprise pricing tier",
  "limit": 5
}
```

Response:
```json
{
  "data": [
    {
      "id": 421,
      "chunk_text": "Professional teeth whitening lifts years of staining...",
      "ts": "2024-11-12T14:23:01Z",
      "similarity": 0.66,
      "engagement": 0.75,
      "depth": "deep"
    }
  ],
  "limit": 10, "offset": 0, "has_more": false
}
```

Paginated (`limit` ≤100, default 10). Embeds the query, vector-searches chunks scoped to that passport, and returns top matches ranked by relevance **blended with reading depth** — a deeply-read paragraph outranks a skimmed heading of similar relevance (a heading that *is* the query phrase can score the highest raw similarity yet rank below the paragraph the customer actually read). Each hit carries `engagement` (0–1 depth weight) and `depth` (`glance`/`read`/`deep`); non-text exposures (mail/voip/crm) have no depth signal and use `engagement = 1`.

Pass **`min_similarity`** (0–1, default 0 = off) to apply a relevance **floor** *before* the depth blend — chunks below it are dropped rather than returned as weak "best of a bad lot" matches. Without it, a single-domain corpus returns off-topic results (every dental paragraph scores ~0.4 against any dental query); a floor of ~0.45 keeps only genuinely on-topic content. The console's `Recall` defaults to `0.45`.

### `POST /analytics/population` — cohort awareness

> "How many users know about X?"

Request:
```json
{
  "query": "spring promotion 25% discount",
  "similarity": 0.78,
  "limit": 50,
  "offset": 0
}
```

Response:
```json
{
  "total": 1284,
  "data": [
    {
      "passport_id": "a1b2c3d4-...",
      "hits": [{ "chunk_text": "...", "similarity": 0.94, "ts": "..." }]
    }
  ],
  "limit": 50, "offset": 0, "has_more": true
}
```

`total` = the cohort size (distinct passports matching above the similarity threshold). `data` is the paginated drilldown of those passports.

Parameters:
- `similarity` — cosine threshold (default 0.75). Raise for strict concept matches, lower for fuzzy theme matches.
- `limit` / `offset` — page the passport drilldown (`limit` ≤200, default 50). `total` stays the full cohort size.
- `min_engagement` — optional reading-depth gate (0–1, default 0 = off). A web text read only puts a passport in the cohort if its depth weight clears this — e.g. `0.15` counts genuine reads but excludes skimmed headings (a heading scores ~0.05). Non-text exposures (mail/voip/crm — no depth signal) always qualify, so this never drops a customer who *called* or *was emailed* about the concept. Lets "how many customers are interested in X" mean readers, not glancers.

### `GET /analytics/timeline/:passport_id` — raw exposure history

> "Show me everything we have for this person."

Query parameters:
- `from`, `to` — ISO timestamps
- `channels` — comma-separated: `mail,voip,web`
- `directions` — comma-separated: `exposure,expression,conversation`

Response: the standard `{ data, limit, offset, has_more }` envelope; `data` is exposure rows ordered by `ts` descending (`limit` ≤200, default 50). No embedding logic — just a SQL filter on the exposures table. Page with `?limit=&offset=`.

### `POST /analytics/ask` — LLM-synthesized answer

> "Answer a natural-language question about this customer, grounded in their content history."

Request:
```json
{
  "passport_id": "a1b2c3d4-5678-4abc-89de-1234567890ab",
  "question": "Has this user been told about the refund policy? When?",
  "limit": 10
}
```

Response:
```json
{
  "answer": "On 2024-11-12 the user read a pricing-page section that included the 30-day refund clause. They have not been sent the refund policy via email or discussed it on any call.",
  "evidence": [
    {
      "id": 421,
      "chunk_text": "...30-day refund policy...",
      "ts": "2024-11-12T14:23:01Z",
      "channel": "web",
      "direction": "exposure",
      "utm_source": "google",
      "utm_campaign": "spring-2025",
      "similarity": 0.91
    }
  ]
}
```

Flow:
1. Calls `awareness.recall({ passport_id, query: question, limit })` to retrieve the top relevant chunks
2. Formats them as evidence with timestamps, channel/direction, and UTM attribution
3. Sends the evidence to GPT-4o with a grounded-answer system prompt
4. Returns both the synthesized answer and the raw evidence

When recall returns no hits, no LLM call is made — the response is `{ answer: "No relevant content found...", evidence: [] }`. This avoids paying for an LLM call to say "I don't know."

The system prompt enforces:
- Ground every claim in evidence
- Cite timestamps
- Mention UTM attribution when relevant
- Don't invent attribution when UTMs are absent
- Distinguish exposure vs expression
- Weight reading depth + intent — a skimmed heading or passively-viewed image (a "glance") is incidental, not a stated interest; lead with what the customer genuinely read or actively did
- Stay concise

### `POST /analytics/ask-population` — LLM-synthesized answer over the whole base

> "Answer a natural-language question about the entire customer base, not one customer."

The cohort sibling of `/ask`. Where `/ask` grounds a single passport's recall, `ask-population` answers about the base as a whole. **No `passport_id`.** It grounds on two things:

1. **Base-wide stats** (always) — total customers and a breakdown of content events by channel/direction. This makes counting/aggregate questions ("how many customers do we have?") exact.
2. **Evidence** — *either* the semantic cohort that matches the question (collapsed into representative content weighted by how many distinct customers it reached), *or*, when the question maps to no cohort (a broad/overview question), a query-independent **base-wide content sample** (biased toward what customers *express*, not just what we broadcast).

So it works for both *targeted* questions ("what do customers who asked about pricing want?") and *whole-base* questions ("what are people interested in?", "what's going on across everyone?") — the latter no longer dead-ends on an empty cohort.

Request:
```json
{
  "question": "What are customers most interested in right now?",
  "similarity": 0.6,
  "limit": 1000
}
```

Response:
```json
{
  "answer": "Pricing and SSO dominate: dozens of customers asked about per-seat pricing, and a recurring theme among enterprise visitors is SAML/SSO. Refund terms come up far less often.",
  "cohort": { "count": 137 },
  "stats": {
    "customers": 4120,
    "exposures": 38117,
    "breakdown": [
      { "channel": "web", "direction": "exposure", "exposures": 21044, "customers": 4001 },
      { "channel": "mail", "direction": "expression", "exposures": 980, "customers": 612 }
    ]
  },
  "evidence": [
    {
      "chunk_text": "How is pricing structured for larger teams?",
      "channel": "mail",
      "direction": "expression",
      "similarity": 0.88,
      "passport_count": 41
    }
  ]
}
```

- `stats` — base-wide totals + channel/direction breakdown, always present. Use it for "how many" questions.
- `cohort.count` — distinct customers whose content matched the question (the semantic cohort, not the whole base). `0` means nothing matched the specific concept; the answer is then drawn from the base-wide sample (and `evidence[].similarity` is `null`).
- `evidence[].passport_count` — how many distinct customers that content reached; the model uses this to ground magnitude.
- Parameters: `similarity` (default `0.5` — a full natural-language question embeds further from the content than a bare concept, so this is looser than raw `population`'s `0.75`; at `0.6` a question like "what are patients asking about insurance?" matched *nobody* despite many having read the insurance copy, which forced a misleading empty-cohort fallback), `limit` (max chunks scanned, default 1000).
- Only short-circuits (no LLM call) when the base is genuinely empty: `{ answer: "There are no customers in the base yet.", cohort: { count: 0 }, stats, evidence: [] }`.

Like `/ask`, it delegates to the awareness core (`awareness.askPopulation`) and accepts the same `instruction` / `schema` overrides from there. There is **no** per-customer structured-context step — the context registry is per-passport.

### Context providers (how other plugins feed `/ask`)

`/ask` answers from two sources:

1. **Evidence** — semantic recall over awareness chunks (mail bodies, web text, transcripts, CRM notes …). This is automatic for anything routed through `awareness.record()`.
2. **Structured context** — current-state JSON from external systems (CRM rows, billing status, open tickets …). This comes from a generic registry — `ctx.context`.

Plugins opt in by calling `ctx.context.register(name, fn)` during their setup:

```js
// inside someplugin's register(app, ctx)
ctx.context.register('billing', async (passportId, { limit = 20, offset = 0 } = {}) => {
  return db('subscriptions')
    .where({ passport_id: passportId })
    .orderBy('created_at', 'desc')
    .limit(limit)
    .offset(offset)
})
```

Each provider:
- Returns JSON-serializable data (array or object).
- Respects `opts.limit` and `opts.offset` so `/analytics/context` paging works. `/ask` always calls with `limit: 20, offset: 0`.
- Should be cheap — one indexed DB query, no LLM calls. `collect()` runs on every `/ask`.
- Should not throw — exceptions are caught and surfaced as `null` for that key.

Analytics has zero knowledge of which plugins are registered. The CRM plugin's registration is the canonical example (see `plugins/crm/index.js`). Use `GET /analytics/context/:passport_id` to inspect what each provider returns without paying for an LLM call.

### UTM attribution in responses

All read endpoints (`recall`, `population`, `timeline`, `ask`) include UTM data joined from the sessions table:

```
utm_source, utm_medium, utm_campaign, utm_term, utm_content, referrer
```

For exposures without a linked session, these are `null`. Consumers can filter or surface attribution client-side.

### `GET /analytics/context/:passport_id` — inspect structured context

> "What does `/ask` see for this customer before it calls the LLM?"

Returns whatever each registered context provider returns for the passport. Same call `/ask` makes internally, with the LLM step skipped — useful for verifying that a newly added plugin is feeding the right shape into the prompt, and for debugging when an answer omits something you expected.

Query params:
- `provider` — comma-separated allowlist (`?provider=crm,billing`). Default: all registered. Unknown names return **400** so typos aren't silently swallowed.
- `limit` / `offset` — same pagination params as every other endpoint (default 20, `limit` ≤200), passed to each provider, which is expected to honor them.

Unlike the list endpoints, the response is a **map** of providers (so there's no single `data` array); it carries the same `limit`/`offset` plus a per-provider `has_more`.

```bash
# Default — all providers, first 20 entries each
curl -H "Authorization: Bearer $T" \
  "https://api.example.com/analytics/context/$PASSPORT_ID"

# Only CRM, second page of 10
curl -H "Authorization: Bearer $T" \
  "https://api.example.com/analytics/context/$PASSPORT_ID?provider=crm&limit=10&offset=10"
```

Response:
```json
{
  "providers": ["crm"],
  "limit": 10,
  "offset": 10,
  "has_more": { "crm": true },
  "context": {
    "crm": [
      {
        "source": "booking",
        "kind": "reservation",
        "external_id": "res_88421",
        "status": "confirmed",
        "starts_at": "2026-06-12T14:00:00Z",
        "data": { "room_type": "Deluxe Suite", "nights": 3 }
      }
    ]
  }
}
```

`has_more` is a best-effort hint per array-returning provider: `true` when the slice came back full (likely more on the next page), `false` otherwise. Object-returning providers (e.g. `billing: { plan: 'pro' }`) are omitted from `has_more`. There is no total count — paginate forward until `has_more` is false.

When no plugins have registered providers, returns `{ providers: [], limit, offset, has_more: {}, context: {} }`. No LLM call, no embedding call — pure registry walk + per-provider DB query.

### `DELETE /analytics/passport/:passport_id` — GDPR forget

Deletes all exposures + chunks for that passport (chunks cascade via FK). Returns:
```json
{ "deleted": 47 }
```

Fires the `awareness.forgotten` notify event so external systems can react (mail row deletion, voip recording purge, etc.).

## Auth

Generic bearer-token middleware from `core/auth.js`. Configured via:

```js
config.analytics = { auth: { secret: 'your-bearer-token' } }
```

If the secret is missing, the plugin fails at startup — analytics endpoints are never accidentally unprotected.

Header format:
```
Authorization: Bearer your-bearer-token
```

## Validation

All POST endpoints use Zod schemas:

- `recall` — passport_id (UUID v1–v8), query (non-empty string), limit (1–100)
- `population` — query (non-empty string), similarity (0–1), limit (1–10000)
- `timeline` — passport_id from URL param

400 on validation failure with the Zod error flattened in the response body.

## Usage example

```js
const res = await fetch('https://api.example.com/analytics/recall', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${process.env.WHITEBOX_TOKEN}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    passport_id: customer.passport_id,
    query: 'refund policy',
    limit: 5,
  }),
})

const { hits } = await res.json()
const seen = hits.some(h => h.similarity > 0.8)
```

For richer flows (LLM-synthesized answers, multi-step queries), the consumer layers that on top — analytics gives you grounded retrieval, your code adds synthesis.

A full client wrapper example is in the project root [README.md](../../../README.md).

## What this plugin is NOT

- **Not a dashboard.** No HTML, no charts, no UI. That's a separate concern — write an admin app that consumes these JSON endpoints.
- **Not just a Q&A surface.** Most endpoints return raw matches. `/ask` adds a grounded synthesis layer on top — but it composes `recall` + an LLM call. The retrieval primitives stay usable on their own.
- **Not a streaming endpoint.** Returns full result sets. For very large cohorts, paginate using `limit` and re-issue.
- **Not where awareness data is written.** Mail/voip/engagement plugins write into awareness. Analytics only reads.
- **Not public.** All endpoints require auth. There's no equivalent of the public `/mail/inbox` form route here.

## Config shape

```js
config.analytics = {
  auth: {
    secret: 'long-random-bearer-token',
  },
}
```

That's it. All other behavior is delegated to `config.awareness`.

## Operational properties

- **No persistent state.** Restarting the plugin loses nothing.
- **No background jobs.** No workers, no schedules.
- **Stateless requests.** Each request is independent; no session, no rate limiter built in (add at the reverse proxy / WAF layer).
- **Embedding latency.** Recall and population issue a single embedding call to OpenAI (`text-embedding-3-small` by default — typically ~50ms). Timeline is pure SQL, no LLM call.

## Test coverage

```
tests/plugins/analytics/index.test.js   18 tests
  - recall: auth required, validation 400, success, error 500
  - population: auth required, validation 400, success
  - timeline: filters from query string, success
  - forget: success, deletion count
  - ask: auth, validation, success, evidence formatting,
         empty-recall short-circuit, openai error, limit passthrough
```

Tests mount the plugin on a fresh Express app with a mocked awareness module. No DB needed.

## Known gaps

1. **No pagination cursor** — `recall` and `population` cap by `limit`, no way to fetch "next page" of results.
2. **No saved queries** — every query is independent; can't build named queries / dashboards from within the plugin.
3. **No rate limiting** — relies on auth gate alone. For production with multiple admin clients, add a rate limiter at the proxy layer.
4. **No LLM synthesis endpoint** — by design (see "What this plugin is NOT"). Could be added as a thin extra route that pipes recall results through GPT.
5. **No streaming** — long timelines load fully into memory before serializing.

## Extending

`/ask` is the canonical example of retrieval-primitive-plus-synthesis. For other synthesis patterns (cohort summaries, content-effectiveness rollups, drop-off analyses), follow the same shape:

1. Pull grounded evidence from `awareness.recall`, `.population`, or `.timeline`
2. Format it with timestamps + attribution context
3. Send to `openai.prompt` (or `openai.chat.completions.create` for richer control) with a constrained system prompt
4. Return `{ answer, evidence }` so callers can verify or override the synthesis

Keep these endpoints separate from the retrieval primitives so consumers can pick their abstraction level.

## Ad-network reporting

Analytics is purely query/recall over awareness. **Conversion reporting to the ad
networks moved to [`whitebox-pro-server-plugin-conversions`](../server-plugin-conversions)**,
which receives `/conversions/events` and fans out to composed network packages
(`whitebox-pro-adnetworks-meta` / `-google` / `-tiktok`), deduped against the browser
pixels by `event_id`.
