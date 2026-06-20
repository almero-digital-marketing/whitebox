# Facts — the structured memory (core)

**Status:** Spec — decisions D1–D6 settled (§10); ready to build, no code yet.
**Why now:** this is the foundation the planned *selector* (the unified
analytics/audiences query) rests on. The selector promises structured filtering
and point‑in‑time (`asOf`) queries; both are dishonest on the current
latest‑only store, and that store is trapped inside the CRM plugin under the
"crm" name. Lift it into core as a generic primitive first.

> **Naming:** in core this is **facts**, the structured twin of **awareness**. It
> is channel‑agnostic. "CRM" is just one *source* that writes facts (and one
> ingestion door) — the term never appears in the core API, table, or selector.

---

## 1. The problem

WhiteBox already has one memory in core — **awareness** — an append‑only,
time‑stamped, semantic record of everything a person did. But the *structured*
side of a person (plan, MRR, status, renewal date) lives in the **CRM plugin**, as
mutable latest‑only state. Three consequences:

```text
✗ "plan_tier == 'pro'"           — the gate only checks the key is PRESENT, not its value
✗ "was Pro on Black Friday"      — records upsert; the past value is gone
✗ "downgraded in the last 30d"   — no history → no transitions
```

And a fourth, structural one: **structured state is owned by a plugin and named
after one source** (`crm`), when it's really a core memory that *any* source
should be able to write and *every* query should be able to read.

## 2. The fix, in one line

Promote structured state to a **core, append‑only, typed, value‑queryable fact
timeline** — the structured twin of awareness — written through a core primitive
(`ctx.facts`), readable by the selector. CRM stops *owning* this data and becomes
one *source* that writes it.

```
awareness  =  append‑only SEMANTIC   memory   (ts,  text → embedded)         → fuzzy
facts      =  append‑only STRUCTURED memory   (observed_at, key, value:type) → exact
```

Each is a per‑passport timeline. **Current** = latest value per key.
**As of D** = the value whose validity window contains D (`max(observed_at ≤ D)`).
Nothing is ever overwritten — a value change is a new row.

## 3. The model (core)

A **fact** is one observation of one attribute of one person at one time. The
`source` records where it came from (`stripe`, `hubspot`, `billing`, `app`, …) —
no source is privileged, and none is called "crm":

```sql
whitebox_facts (
  id           bigserial primary key,
  passport_id  uuid        not null references whitebox_passports,
  key          text        not null,   -- 'plan_tier' | 'mrr' | 'subscription_status' | 'renewal_date'
  value        jsonb       not null,   -- typed: "pro" | 240 | true | "2026-07-01"
  type         text        not null,   -- 'string' | 'number' | 'bool' | 'date'
  source       text        not null,   -- where it came from: 'stripe' | 'hubspot' | 'app' | …
  entity       text,                   -- optional link to an external entity, e.g. 'subscription:sub_123'
  observed_at  timestamptz not null,   -- VALID time: when this value became true
  recorded_at  timestamptz not null default now()  -- when we learned it (audit)
);
-- index: (passport_id, key, observed_at desc)   ← current / as-of per passport
-- index: (key, observed_at desc)                 ← population scans
```

A value is valid from its `observed_at` until the next row for the same
`(passport_id, key)` — validity windows are **derived**, never stored, so
late‑arriving facts just slot in by `observed_at`.

### Running example

One customer, `passport = p1`, over four months — each line is a row in
`whitebox_facts` (`source = stripe` omitted for brevity):

```text
key                 value        type    observed_at
─────────────────────────────────────────────────────
plan_tier           "free"       string  2026-03-01
mrr                 0            number  2026-03-01
plan_tier           "pro"        string  2026-04-10   ← upgraded
mrr                 240          number  2026-04-10
seat_count          3            number  2026-04-10
subscription_status "active"     string  2026-04-10
seat_count          7            number  2026-05-20   ← grew
mrr                 560          number  2026-05-20
subscription_status "cancelled"  string  2026-06-15   ← churned
```

Every query below runs against *this* timeline.

## 4. Reading — the core `ctx.facts` API

### Current value
```js
await ctx.facts.current('p1')
// → { plan_tier: "pro", mrr: 560, seat_count: 7, subscription_status: "cancelled" }
```
```sql
SELECT DISTINCT ON (key) key, value FROM whitebox_facts
WHERE passport_id = 'p1' ORDER BY key, observed_at DESC;
```

### As‑of value (time travel)
```js
await ctx.facts.asOf('p1', '2026-05-01')
// → { plan_tier: "pro", mrr: 240, seat_count: 3, subscription_status: "active" }
//   (the May-20 / Jun-15 rows don't exist yet at that instant)
```
```sql
SELECT DISTINCT ON (key) key, value FROM whitebox_facts
WHERE passport_id = 'p1' AND observed_at <= '2026-05-01' ORDER BY key, observed_at DESC;
```

That one `AND observed_at <= D` is the entire time‑travel mechanism. It's exact,
because nothing was overwritten.

### Value operators
The selector's structured clause filters on the current (or as‑of) value. Full set:
`present` · `eq` · `ne` · `in` · `gt` · `gte` · `lt` · `lte`, plus three relative‑date
ops for date values — `within` (upcoming), `since` (recent), `before` (older):

```text
{ fact: { plan_tier:           { eq: "pro" } } }
{ fact: { mrr:                 { gte: 200, lte: 400 } } }            -- multiple ops AND → a range
{ fact: { subscription_status: { in: ["active", "trialing"] } } }
{ fact: { renewal_date:        { within: "30d" } } }   -- date in the NEXT 30d (upcoming)
{ fact: { last_order_at:       { since:  "30d" } } }   -- date in the LAST 30d (recent)
{ fact: { last_order_at:       { before: "60d" } } }   -- date older than 60d ago
{ fact: { plan_tier:           { present: true } } }   -- old "requires.crm" behavior, still here
```

> ⚠️ **`within` direction.** As a value op on a *date*, `within` is the **upcoming**
> window (the value's date is in the next N). But for the temporal ops below — and for
> the selector's **metric** `within` — it's the **lookback** window (happened in the
> last N). Same word, opposite directions; to be disambiguated before the metric layer
> ships (open item, §11).

### Change / transition predicates
History unlocks predicates about *movement*, not just state:

```text
{ fact: { plan_tier:           { transition: { to: "cancelled", within: "30d" } } } }  -- churned recently
{ fact: { mrr:                 { decreased: { within: "30d" } } } }                    -- downgrade signal
{ fact: { seat_count:          { increased: { within: "30d" } } } }                    -- expansion signal
{ fact: { plan_tier:           { changed:    { within: "30d" } } } }                   -- any plan change
```

(Temporal ops: `changed` · `transition {to?,from?}` · `decreased` · `increased`. Here
`within` is the **lookback** window — see the direction note above.)

Against `p1` on 2026‑06‑20: `plan_tier transition→cancelled within 30d` ✅ (Jun‑15).

## 5. Writing — core primitive + sources

Recording a fact is a **core primitive**, the structured twin of
`awareness.record()`. Any plugin (or core ingestion) can call it:

```js
ctx.awareness.record({ passport_id, channel, text, … })          // semantic memory
ctx.facts.record({ passport_id, key, value, type, source, observed_at, entity? })  // structured memory
```

**Sources are plugins/adapters, not owners.** The most common one is an external
system‑of‑record adapter — that's what today's CRM plugin becomes:

- it exposes the authed HTTP door external systems POST to,
- resolves `{ email, phone, external_id } → passport` (identity resolution is
  generic and moves to **core/passports**, shared by every ingester),
- maps an incoming entity's fields to `ctx.facts.record()` calls,
- optionally keeps an *entity* table (`subscriptions`, `tickets`) for "list this
  customer's subscriptions," and emits facts from it.

```jsonc
// the CRM adapter receives this …
{ "source": "stripe", "customer": { "email": "ada@acme.com" },
  "records": [{ "kind": "subscription", "external_id": "sub_123", "status": "active",
                "starts_at": "2026-04-10", "data": { "plan_tier": "pro", "mrr": 240 } }] }

// … and turns it into core facts (no "crm" in the core call):
ctx.facts.record({ passport_id, key: "plan_tier",           value: "pro",    type: "string", source: "stripe", observed_at: "2026-04-10", entity: "subscription:sub_123" })
ctx.facts.record({ passport_id, key: "mrr",                 value: 240,      type: "number", source: "stripe", observed_at: "2026-04-10", entity: "subscription:sub_123" })
ctx.facts.record({ passport_id, key: "subscription_status", value: "active", type: "string", source: "stripe", observed_at: "2026-04-10", entity: "subscription:sub_123" })
```

> **No mirroring (decided, D5).** A datum is routed by shape and goes to exactly
> one memory: a **typed value** → facts only; a **free‑form note** → awareness only.
> Typed facts are never embedded — that would pollute semantic recall with
> structured churn and cost embeddings. The `judge`/`ask` still see current facts as
> *structured* context (passed to the LLM directly), so a fact is usable in
> reasoning without ever entering the vector store.

## 6. Why this makes the selector coherent

The selector's two query mechanics stop being two awkward systems and become the
**two core memories**:

| selector clause | reads | mechanic | time field |
|---|---|---|---|
| `about` / `judge` | awareness (semantic timeline) | vector + LLM | `ts` |
| `filter.fact` | facts (structured timeline) | typed predicate | `observed_at` |
| `filter.metric` | awareness aggregates (count/recency/dwell) | SQL | `ts` |

Both memories are append‑only, per‑passport, and honor the same `asOf`. A selector
that mixes them is honest at any instant:

```js
// "Pro, non-cancelled customers reading about competitors" → churn-risk audience
selector = {
  about: "competitor, switching, alternatives, cancel",        // semantic memory
  filter: { all: [
    { fact: { plan_tier:           { eq: "pro" } } },           // structured memory (current)
    { fact: { subscription_status: { ne: "cancelled" } } },
  ] },
}

resolve(selector)                       // who matches now
resolve(selector, asOf: "2026-11-29")   // who matched as of Black Friday — both memories roll back together
```

## 7. Examples gallery

```js
// 1. Upsell-ready: on Pro, near a seat ceiling, reading about scale
{ about: "limits, more seats, scale, usage",
  filter: { all: [ { fact: { plan_tier: { eq: "pro" } } },
                   { fact: { seat_count: { gte: 5 } } } ] } }

// 2. Win-back: cancelled in the last 60 days, was once high-value  (pure structured → no LLM)
{ filter: { all: [ { fact: { subscription_status: { transition: { to: "cancelled", within: "60d" } } } },
                   { fact: { mrr: { gte: 200 } } } ] } }

// 3. Renewal nudge: renews within 30 days and web engagement has gone quiet
{ filter: { all: [ { fact: { renewal_date: { within: "30d" } } },
                   { metric: { channel: "web", recency_days: { gte: 14 } } } ] } }

// 4. Fast converters (time-travel): Free at signup, Pro within 90 days
//    → ask the timeline at signup and at signup+90d (a knowledge query)

// 5. Mixed-memory churn signal (the §6 example) → audience
```

Note #2 and #3 use **only** `filter` — no semantic narrow, no LLM. A purely
structured, deterministic segment is now first‑class (and free).

## 8. Migration

1. **Seed** `whitebox_facts` from today's `whitebox_crm_records`: emit each
   record's current fields as facts with `observed_at = updated_at` (or `starts_at`).
2. **Switch** ingestion to append through `ctx.facts.record()`; the CRM adapter
   still upserts an entity row for identity/dedup, but the *queryable truth* is the
   core fact timeline.
3. **Move** identity resolution into core/passports (shared by all ingesters).

**Honesty note:** this buys history **from cutover forward**. The past you never
recorded can't be reconstructed — `asOf` before the migration returns the value
*as it was at migration*, not as it truly was then. An argument to land it sooner.

## 9. Where this leaves the architecture

The same hollowing we found for analytics and audiences applies here — and it's
the shape the whole redesign converges on:

```
core       memories (awareness + facts) + identity + selector engine
           └── QUERY → REST /query · /preview  +  MCP query · preview   ← first-class surface

plugins    write     (mail / sms / voip / engagement / conversions / crm → the two memories)
           activate  (audiences → save a people-selector + delivery + keep-warm)

analytics  the UI — query builder + segment / audience manager, over core QUERY + audiences
```

CRM is no longer a *data module*; it's the **structured‑facts write‑channel** —
the twin of how mail/voip write the semantic memory. It survives only as the
external‑system ingestion door (+ optional entity convenience), and it does so
*without the core ever knowing the word "crm."*

## 10. Decisions — settled

| # | decision | ✅ decided |
|---|---|---|
| D1 | core term | **`facts`** — `ctx.facts`, `whitebox_facts`, `filter.fact` (generic; pairs with `awareness`) |
| D2 | time model | **valid‑time** — `observed_at` is the query axis; `recorded_at` is audit‑only (bitemporal is a clean v2) |
| D3 | fact grain / entities | **collapsed `passport + key` facts in core + entity table in the adapter**; per‑entity facts are a later refinement |
| D4 | value operators | **full** — value: `present/eq/ne/in/gt/gte/lt/lte` + date `within/since/before`; temporal: `changed/transition/decreased/increased` — over typed jsonb (§4) |
| D5 | facts vs awareness | **hard split, no mirror** — typed value → facts only; free‑form note → awareness only |
| D6 | as‑of scope | **awareness + facts** — both memories roll back together (the §8 cutover caveat is the only asterisk) |

## 11. Out of scope / open

- **Open — `within` direction:** value‑op `within` (upcoming) reads opposite to the
  temporal‑op / selector‑metric `within` (lookback). Pick a disambiguating name (e.g.
  rename one to `next`/`last`, or `due_in`) **before the selector metric layer ships.**
  Naming call — pending.
- **Sequencing / funnels** — "pricing **then** demo **within** 2 days." The model is
  set‑based (windowed aggregates), not sequence‑based. Separate axis, later.
- **Full bitemporal querying** — "what did we *believe* on date X" (via
  `recorded_at`). Column's there; query surface is v2.

---

**Next (after D1–D6):** the `whitebox_facts` core table + migration, the
`ctx.facts` write + `current`/`asOf`/operator read layer, identity resolution into
core/passports, and re‑pointing the CRM plugin at `ctx.facts` as a thin adapter.
No selector work yet — this is the brick under it.
