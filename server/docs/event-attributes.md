# Event attributes — query the activity stream by what it *means*, not by a `content_id` slug

**Status:** Proposal. Touches **core** (`selector/metric.js` + one awareness migration). Core is owned by the core agent — this is the contract/solution to hand over, not something the analytics module lands unilaterally. The analytics module and integrations are the consumers. See [selector.md §5–§7](selector.md), [temporal-facts.md](temporal-facts.md), [analytics-concept.md](analytics-concept.md). For the integration-author's view — what to send and where — see [instrumentation.md](instrumentation.md).

---

## 1. The problem

The selector's `metric` clause slices the event stream (`whitebox_awareness_exposures`) by a **fixed, tiny set of dimensions**: `channel`, `direction`, `source` (group only), and a **substring of `content_id`** (filter + group). `meta.*` is reachable only as the single numeric `field` of a `sum` — never as a filter or a group dimension.

So any event dimension that *isn't* one of those columns — "which campaign", "what action happened", "which treatment", "what device" — has nowhere to live except **packed into `content_id` as a delimited slug** and matched by substring:

```
content_id = "campaign:spring_botox:email:open"
metric.content = ":email:open"      // substring-match the "action" segment
```

That has three costs:

1. **It pushes taxonomy modeling onto the customer.** `content_id` is whatever the source emits — an email message-id, a page URL, a call-id. A `kind:campaign:channel:action` grammar only exists if the customer invents it *and enforces it across every integration*. That is upfront data modeling — the exact opposite of "fits the stack you already have" ([analytics-concept.md](analytics-concept.md), integration-first).
2. **It's fragile.** Substring matching is positional and unanchored — `:email:open` works by luck of the delimiter. Rename a segment and every query silently returns the wrong set, no error.
3. **It stores the same dimension three ways.** Campaign already has a canonical typed home — `whitebox_sessions.utm_campaign`, populated the standard UTM way (`/sessions/resolve`). But the metric engine can't join sessions, so to *break down by* campaign I packed it into `content_id` **and** mirrored it as a per-passport `utm_campaign` fact — three copies of one dimension, in three query languages, free to drift.

The demo makes all three visible: the email funnel matches `:email:sent`/`:email:open`/`:email:click`, while "Acquisition by campaign" is a *separate* `breakdownFact` on `utm_campaign` — same concept, encoded two different ways.

---

## 2. Root cause (precise)

In [`selector/metric.js`](../src/selector/metric.js):

```js
const FILTER_KEYS = ['content', 'channel', 'direction', 'last']     // meta.* not filterable
const DIM_COL = { channel: 'channel', direction: 'direction', source: 'source', content: 'content_id' }   // closed group allowlist
// applyFilters: q.whereILike('content_id', `%${content}%`)         // the substring match
```

The exposure row **already carries a `meta` jsonb** — the recording path (`awareness.record`) writes whatever the caller passes. The data is present; the query layer just can't reach it as a dimension. This is a query-engine gap, not a storage gap.

---

## 3. The model we want

Every dimension already has — or should have — a **natural typed home**. The engine's
job is to *reach* those homes, not to flatten them into one `content_id` string. Where
a dimension lives follows from what it describes:

| dimension | lives on | populated by |
|---|---|---|
| acquisition — `utm_source/medium/campaign/term/content`, `referrer` | **`whitebox_sessions`** columns | the standard UTM mechanism — `/sessions/resolve` reads them off the query string |
| event basics — `channel`, `direction`, `source` | `whitebox_awareness_exposures` columns | the recording adapter |
| open per-event dims — `event` (the action), `value`, `treatment`, … | exposure `meta` jsonb | the recording adapter |
| per-passport state — `client_status`, `membership`, LTV, first-touch campaign | `whitebox_facts` | `facts.record` (often *derived* from the rows above) |

- **`content_id` is untrusted, optional garbage** — whatever the source happened to put there (a message-id, a URL, junk, or nothing at all). At most a best-effort opaque reference for dedup/linking; it may be null, duplicated, or malformed, so **nothing structural may depend on it** — don't substring/prefix/parse/group it, and don't even assume it's a reliable key. (Today's `metric.content` substring match is exactly that violation — deprecated, see §4.)
- **UTM is the headline case, and it's already done right.** It's typed columns on the session, ingested the standard way: a web SDK passes `?utm_campaign=…` to `/sessions/resolve`, exactly like every analytics tool. The customer models nothing. Each event links to that session via `exposures.session_id`.
- **`channel` / `direction` / `source` stay first-class exposure columns** — low-cardinality, indexed. Only genuinely *open-ended* per-event dims live in `meta`.
- **The fact/event boundary holds** ([selector.md §5](selector.md)): an **event** is one thing that happened (it joins to a session for acquisition context); a **fact** is per-passport state — e.g. *first-touch* campaign is a fact **derived from the first session's UTM**, not independently typed. The same dimension stops being stored twice.

---

## 4. Core solution — let the metric engine reach the dimensions that already exist

Minimal, **additive, backward-compatible** changes to `selector/metric.js`. The metric
query runs over `whitebox_awareness_exposures` today; we (a) join sessions and (b) read
meta. Nothing existing changes.

### 4.0 Session-joined dimensions — the UTM home (do this first)

`exposures.session_id → whitebox_sessions` already carries the typed acquisition columns.
Let metric filter and group by them:

```js
{ metric: { session: { utm_campaign: "spring_botox_2026" }, count: { gte: 1 } } }   // filter
group: { by: "session:utm_campaign" }                                               // group
```

- Implemented as `LEFT JOIN whitebox_sessions s ON s.id = exposures.session_id`, then
  `WHERE s.utm_campaign = ?` / `GROUP BY s.utm_campaign`.
- The session column set is a **fixed allowlist** (`utm_source/medium/campaign/term/content`,
  `referrer`) → safe to reference by name; values are bound. No injection surface.
- `session_id` is **nullable** — events with no session don't match a `session` filter and
  fall in a `null` bucket when grouped. Document that.
- This is the **primary** fix: campaign/source/medium are the most-wanted slices and they
  already exist as typed columns — the engine simply can't reach them yet. It does **not**
  need the meta work below; that covers a different gap (open per-event dims).

### 4.1 Filter by attribute (open per-event dims with no typed home)

Add an `attrs` object to the metric spec — an AND of equality / `in` / `present`:

```js
{ metric: { attrs: { event: "email_open", campaign: "spring_botox" }, count: { gte: 1 } } }
```

| form | meaning | SQL (bound) |
|---|---|---|
| `attrs[k] = v` | equals | `meta ->> ? = ?` |
| `attrs[k] = { in: [...] }` | one of | `meta ->> ? = ANY(?)` |
| `attrs[k] = { present: true }` | key exists | `jsonb_exists(meta, ?)` |

The attribute **key and value are bind parameters** (`meta ->> ?`), never string-inlined → injection-safe (the current `DIM_COL` allowlist exists precisely because time-grain formats are inlined; attrs avoid that by binding). Note: the `present` check uses `jsonb_exists(meta, ?)` rather than the `meta ? key` operator, because Postgres's `?` jsonb operator collides with knex's `?` bind placeholder.

The legacy `content` **substring** filter is **deprecated** — it is the precise violation
this note removes (it reads structure out of a string that must stay opaque). It keeps
resolving during migration only, nothing new uses it, and it is slated for removal once
analytics stops referencing it (§6). If a "which specific content" filter is ever needed,
it's **exact identity** on the opaque id — never a substring, never a prefix.

### 4.2 Group by attribute

Extend `bucketSql` with an `attr:` prefix:

```js
group: { by: "attr:campaign" }      // → GROUP BY meta ->> 'campaign'
```

```js
function bucketSql(by, binds) {
  if (TIME_FMT[by]) return { sql: `to_char(ts, '${TIME_FMT[by]}')`, binds: [] }
  if (DIM_COL[by])  return { sql: DIM_COL[by], binds: [] }
  if (by.startsWith('attr:')) return { sql: 'meta ->> ?', binds: [by.slice(5)] }   // bound key
  throw new Error(`selector.group: unknown bucket "${by}"`)
}
```

Used in both `select(... as bucket)` and `groupByRaw(...)` with the same bind.

### 4.3 SQL sketch

Gate (people with ≥ N matching events) and group (total bucketed), both fully parameterized:

```sql
-- filter.metric: attrs + window → qualifying passports
SELECT passport_id FROM whitebox_awareness_exposures
WHERE meta ->> 'event' = 'email_open' AND meta ->> 'campaign' = 'spring_botox'
GROUP BY passport_id HAVING count(*) >= 1;

-- group: clicks per campaign
SELECT meta ->> 'campaign' AS bucket, count(*) AS value
FROM whitebox_awareness_exposures
WHERE meta ->> 'event' = 'email_click'
GROUP BY meta ->> 'campaign' ORDER BY 1;
```

### 4.4 Indexing (the one core migration)

jsonb extraction is unindexed by default. Add expression indexes on hot keys, or a GIN index for containment:

```sql
CREATE INDEX ON whitebox_awareness_exposures ((meta->>'event'));
CREATE INDEX ON whitebox_awareness_exposures ((meta->>'campaign'));
-- or, for ad-hoc attr filters:
CREATE INDEX ON whitebox_awareness_exposures USING gin (meta jsonb_path_ops);
```

This is the only part that needs a schema migration. Pick per workload; the `event` key is always worth indexing.

### 4.5 Backward compatibility

Additive on the way in: the new `session:`/`attr:` paths leave `fact` / `about` / `judge`
untouched and existing rows keep resolving. The one thing on a **removal** path is
`metric.content` substring matching — it stays only until analytics migrates off it (§6),
then it goes. Treating `content_id` as structural is the bug being removed, not a feature to preserve.

---

## 5. The integration contract (this replaces customer taxonomy modeling)

**Acquisition (UTM) is not the adapter's job** — it's already captured per-session by
`/sessions/resolve` from the query string. The event just carries `session_id`, and the
engine reaches campaign/source via the join (§4.0). The adapter only sets event basics +
any open per-event dims:

- **columns** — `channel`, `direction`, `source`, `content_id` (the opaque *native* id), `session_id`, `ts`, `text`.
- **`meta`** — open per-event dims with no typed column: at minimum `event` (the canonical action), plus things like `value`, `treatment` that the source provides.

**Canonical `event` vocabulary** — small, shared, open to extension:

```
email_sent · email_open · email_click · sms_sent · sms_click ·
page_view · form_submit · call · booking · purchase · …
```

Each integration maps its native event types to this set. Domain dims (`campaign`, `treatment`, `value`, `device`, `list`, …) are free-form per vertical.

Example — a marketing-email webhook → exposure:

```js
{ channel: 'mail', direction: 'exposure', source: 'mailchimp',
  content_id: 'mc:msg:abc123',                                  // opaque, native
  meta: { event: 'email_open', campaign: 'spring_botox', list: 'newsletter' } }
```

The customer configures *that mapping*, in the integration, once. They never author a `content_id` grammar.

---

## 6. What changes downstream (analytics + seed — owned here)

Once core ships §4:

- **Funnel steps / metric conditions / timeseries** query `attrs: { event: 'email_open' }` (the action) and `session: { utm_campaign: … }` / `group: { by: 'session:utm_campaign' }` (the campaign) — instead of `content: ':email:open'` plus a parallel `utm_campaign` fact.
- **Seed** creates real **sessions with UTM** and links events with `session_id` + `meta.event`, instead of faking UTM as facts and packing the action into `content_id`.
- **Query builder** — the "event tag" field becomes an **event picker + typed filters** (action from `meta.event`, campaign/source from session columns), discovered by the schema endpoint (it already surfaces `channels`; it would surface event actions + session UTM values).
- **"Acquisition by campaign"** groups by `session:utm_campaign`, or — for first-touch per customer — a fact **derived from the first session**. One source of truth (the session), not two.

---

## 7. Scope, ownership, sequencing

| change | where | owner |
|---|---|---|
| `session:` join filter + `session:<col>` group | `selector/metric.js` | **core** |
| `attrs` filter + `attr:<key>` group | `selector/metric.js` | **core** |
| index migration on hot `meta` keys | awareness migration | **core** |
| session/attribute query shapes | analytics composition + builder | analytics (here) |
| real sessions + canonical `meta` on record | seed + each integration adapter | here / integrations |

Suggested order: **(1)** core adds the `session:` join (UTM) — highest value, lowest risk → **(2)** core adds `attrs`/`attr:` for open per-event dims → **(3)** analytics + seed move to session/attribute shapes and drop the duplicated `utm_campaign` fact → **(4)** **remove `metric.content` substring matching** — `content_id` becomes a pure opaque key, never structural.

---

## 8. Open questions

- **`event` vocabulary** — fixed enum or open string? Lean **open string + a documented core set**, so a new vertical isn't blocked on a core release.
- **Fold `channel`/`direction`/`source` into `attrs`?** No — keep them columns. They're low-cardinality, indexed, and already wired everywhere.
- **High-cardinality guardrail** — `group: { by: 'attr:<key>' }` on a near-unique key (a raw url, an event id) would return thousands of buckets. The cost preview ([selector.md §9](selector.md)) should surface bucket count, and group should accept a `limit` / "top N + other".
