# The selector — one query for read *and* segment (core)

**Status:** Spec — decisions S1–S5 settled (§12). Sits on top of
[temporal facts](temporal-facts.md). Ready to build, no code yet.

> **Naming.** A **selector** is the shared predicate ("who / what"). A
> **projection** is what you ask back (knowledge / people / answer). An
> **audience** is a saved *people* selector with a delivery attached. Analytics
> *reads* a selector; audiences *activates* one — same query, different verb.

---

## 1. Why this exists

Analytics and audiences were two filter languages for one job — "select people by
what they did and who they are." That split is what made the system hard to learn
(recall/population/timeline params vs `requires.metric`/`requires.crm`/`seed`).

The selector is the **single predicate both speak.** It reads the two core
memories — [awareness](../src/awareness) (semantic) and [facts](temporal-facts.md)
(structured) — and any current query becomes a *caller* of it.

## 2. The model

```js
selector = { about?, filter?, judge? }            // all three optional

resolve(selector, { projection, scope, asOf }) → result
//   projection: "knowledge" | "people" | "answer"
//   scope:      "passport"  | "base"               (people is always base)
//   asOf:       a point in time                     (defaults to now)
```

- **`about`** — a semantic topic (vector). Ranks (knowledge) or gates (people).
- **`filter`** — a boolean tree of deterministic gates over facts + awareness.
- **`judge`** — an optional LLM predicate for nuance the other two can't express.

Everything is optional, so one shape subsumes every query today:

| today | selector |
|---|---|
| `recall(passport, query)` | `about` · knowledge · scope passport |
| `population(query)` | `about` · people · scope base |
| `timeline(passport, channels, from)` | `filter` · knowledge · scope passport |
| `ask(passport, question)` | `about` · answer · scope passport |
| an audiences `rule` | `selector` + delivery (saved people projection) |

## 3. Resolution — the funnel

Resolving is a funnel: cheap stages narrow before expensive ones, and `asOf`
threads through every memory read.

```
resolve(selector, { projection, scope, asOf })

  scope ─► 1. about    (semantic narrow + rank)        reads AWARENESS  vector  ← cheap-ish
           2. filter   (boolean gates)                 reads FACTS + AWARENESS  ← cheap (SQL)
           3. judge    (LLM predicate, optional)        per surviving candidate  ← EXPENSIVE
           4. project  (knowledge | people | answer)

  asOf ── ts ≤ asOf (awareness) · observed_at ≤ asOf (facts) — both memories roll back together
```

**Worked trace** — churn-risk, `projection: people`, `asOf: Black Friday`:

```js
{ about:  "competitor, switching, cancel",
  filter: { all: [ { fact: { plan_tier: { eq: "pro" } } },
                   { fact: { subscription_status: { ne: "cancelled" } } } ] },
  judge:  { criteria: "genuinely at risk of churning", confidence: 0.7 } }
```

1. **scope = base** → everyone
2. **about** → vector-search awareness → ~1,800 above the similarity floor
3. **filter** → check facts (pro AND not-cancelled) → ~300 *(cheap SQL, no LLM)*
4. **judge** → 300 LLM "at risk?" ≥ 0.7 → ~120 *(expensive — but 300, not 1,800, because filter ran first)*
5. **project people** → `{ count: 120, passports: [{ id, why }] }`

Cost rises left to right; the point is that selectivity does too.

## 4. `about` — the semantic narrow  *(S1)*

`about` is a topic, matched by vector similarity — a *sliding score*, not a yes/no.
How it's used depends on the projection:

- **knowledge → ranker.** Return the most relevant evidence, best first (top-K).
- **people → gate.** Keep everyone above a **similarity floor**; the cohort is
  "all who qualify," never "the top N."

The floor is the **finickiest knob in the system** — too low bloats the cohort
with the vaguely-related, too high empties it. It's surfaced (and tuned) in
preview (§9). `about` is one top-level stage, never a clause inside `filter`.

## 5. `filter` — the boolean tree  *(S2, S3, S5)*

A full boolean tree of deterministic clauses:

```
filter = clause | { all: [filter…] } | { any: [filter…] } | { not: filter }
```

```js
// OR + nesting
{ any: [ { fact: { plan_tier: { eq: "enterprise" } } },
         { all: [ { fact: { plan_tier: { eq: "pro" } } },
                  { fact: { seat_count: { gte: 5 } } } ] } ] }

// NOT
{ all: [ { fact: { subscription_status: { eq: "active" } } },
         { not: { metric: { content: "pricing", channel: "web", recency_days: { lte: 30 } } } } ] }
```

### Clause types

| clause | reads | mechanic |
|---|---|---|
| `fact` | facts timeline (current or as-of) | typed value op |
| `metric` | awareness aggregates over a window | SQL aggregate |
| `channel` / `direction` | awareness dims | equality |

**`fact`** — `{ fact: { <key>: { <op>: <value> } } }`, ops
`eq/ne/in/gt/lt/within/changed/transition/decreased/present`.

**`metric`** — `{ metric: { content?, channel?, within?, <agg> } }`, where `<agg>`
is `count` · `distinct_sessions` · `sum_dwell_ms` · `recency_days` · **`sum`**:

```js
{ metric: { content: "purchase", sum: { field: "value", gte: 500 } } }                 // lifetime spend ≥ $500
{ metric: { content: "purchase", sum: { field: "value", gte: 500 }, within: "30d" } }  // ≥ $500 in last 30 days
```

> **`sum` is currency-naive** — it adds raw `meta.value`. Mixed-currency bases must
> filter to one currency (or normalize upstream); the metric won't do FX.

### `metric` vs `fact` — the rule

The discriminator is **windows**:

- **`fact`** = a point-in-time *attribute* / running total — current plan, the
  `lifetime_value` your source reports, a status. Exact `asOf`, indexed gates.
- **`metric`** = a *windowed aggregate over the event stream* — "spent ≥ $500 **in
  the last 30 days**," "≥ 2 pricing visits **this week**." A sliding window is
  trivial here, awkward as a fact.

*Lifetime / current / source-authoritative → fact. "In the last N days" → metric.*

### The scan anchor  *(S3)*

Enumerating candidates over the whole base needs something to seek on. `about`, or
any **positive** `fact`/`metric` clause, is a natural anchor. A **pure-negative**
(`not …`) or broad `any` has nothing to seek — it means "walk the population and
exclude."

That's still allowed — *"everyone who hasn't purchased in 90 days"* (win-back) is
exactly that shape. **The resolver auto-picks the best anchor when a positive
clause exists; otherwise it falls back to a full-population scan and flags it in
the cost preview** (§9) — so "scan everyone" is always visible, never silent.

## 6. `judge` — the LLM predicate  *(S4)*

For nuance the other stages can't express:

```js
judge: { criteria: "genuinely at risk of churning", confidence: 0.7 }
```

It runs **once per candidate that survives `about` + `filter`**, and receives:
the `about`-recalled evidence + the computed `fact`/`metric` values as **structured
context** (it weighs them, doesn't recompute). It returns `{ match, score }`; keep
if `match && score ≥ confidence`.

It's the only expensive stage, so it always runs *last*, on the already-narrowed
set. Cost is governed entirely by how much `about` + `filter` narrowed first.

## 7. Projections + scope

| projection | returns | scope |
|---|---|---|
| `knowledge` | ranked content / evidence (chunks) | passport or base |
| `answer` | LLM synthesis over the knowledge + citations | passport or base |
| `people` | `{ count, passports: [{ id, why }] }` | base only |

The selector is identical across all three; the projection is *what you ask back*,
not part of the predicate. A `people` projection saved + given a delivery **is an
audience.**

## 8. Time

Three distinct things, kept separate:

- **window** — *which events count* (`within` / `since` / `until` on a clause,
  relative-capable). Lives in `filter`.
- **asOf** — *time-travel*; a resolve-time parameter, applied to every memory read.
  Honest because both memories are append-only — except structured facts before
  the timeline's cutover (see [facts §8](temporal-facts.md)).
- **cadence** — *when a saved selector re-runs*; belongs to the **audience**, not
  the selector. The selector stays a pure function of `(data, asOf)`.

Relative windows in a saved audience stay relative (re-anchored each run), never
frozen to absolute timestamps at save.

## 9. Preview & cost  *(S4)*

Preview makes the only expensive thing — the judge — visible *before* you run or
save. All cheap (no LLM):

- **after `about`** → cohort size at the current similarity floor *(the S1 knob)*
- **after `filter`** → survivors = **exactly the judge-call count**
- **est. cost + latency**, and a **full-scan flag** if there's no anchor (§5)

Plus: **sample the judge on ~20 survivors** → projected qualifying rate + a few
real "why" reasons; and a **confirm-cap** — running/saving above a survivor
threshold needs an explicit confirm, so the judge never sweeps an unbounded set by
accident. *Preview ≡ a `people` resolve with cost metadata* — which is what makes
"what you previewed == what gets delivered" true by construction.

## 10. Examples gallery

```js
// knowledge · passport — "what do we know about Jane re: pricing?"
resolve({ about: "pricing, plans" }, { projection: "answer", scope: "passport", passport: "p1" })

// people · base — interested in whitening (dental)
resolve({ about: "teeth whitening, whitening cost" }, { projection: "people" })

// people · pure structured, NO LLM — win-back (pure-negative, full-scan flagged)
resolve({ filter: { all: [ { fact: { order_count: { gte: 1 } } },
                           { not: { metric: { content: "purchase", recency_days: { lte: 90 } } } } ] } },
        { projection: "people" })

// people · windowed spend — big spenders this quarter
resolve({ filter: { metric: { content: "purchase", sum: { field: "value", gte: 1000 }, within: "90d" } } },
        { projection: "people" })

// people · mixed memory + judge — Pro accounts genuinely evaluating competitors
resolve({ about: "competitor, alternatives, switching",
          filter: { fact: { plan_tier: { eq: "pro" } } },
          judge: { criteria: "seriously evaluating a switch", confidence: 0.7 } },
        { projection: "people" })

// time-travel — who were our >$500 customers at end of Q1?
resolve({ filter: { fact: { lifetime_value: { gte: 500 } } } }, { projection: "people", asOf: "2026-03-31" })
```

## 11. How today maps (migration)

- analytics `recall`/`population`/`timeline`/`ask` → `resolve(selector, { projection, scope })`,
  old params kept as aliases.
- an audiences `rule` → `{ select: selector, delivery, ttl }`; `seed`/`criteria`/
  `threshold` → `about`/`judge`; `requires.metric` → `filter.metric`;
  `requires.crm` → `filter.fact`.
- `preview` → a `people` resolve with cost metadata (§9).

## 12. Decisions — settled

| # | decision | ✅ |
|---|---|---|
| S1 | `about` for knowledge vs people | **ranks for knowledge, gates (similarity floor) for people** |
| S2 | `filter` composition | **full boolean tree** (`all` / `any` / `not`) |
| S3 | scan anchor | **allow full-population scans; auto-pick anchor when positive clause exists; flag full-scans in preview** |
| S4 | judge cost | **count-based preview + ~20-sample judge + confirm-cap** |
| S5 | metric vs fact | **keep both; add windowed `sum`; rule: lifetime/current → fact, "in last N days" → metric** |

## 13. Where this leaves the architecture

The query itself is a **core surface**, exposed both ways — apps and agents resolve
a selector directly against core, no plugin in the path:

```
core       memories (awareness + facts) + identity + selector engine
           └── QUERY → REST  /query · /preview          ← first-class surface
                       MCP   query · preview

plugins    write     (mail / sms / voip / engagement / conversions / crm → the two memories)
           activate  (audiences → save a people-selector + delivery + keep-warm)   [backend]

analytics  the UI — query builder + segment / audience manager, over core QUERY + audiences
```

So **core exposes QUERY** (resolve → knowledge | people | answer) as REST + MCP;
**analytics becomes the UI** (build → preview → save-as-audience — the "view + act"
console); **audiences stays the activation backend** (the data-egress boundary:
networks, consent, keep-warm). A *saved selector / segment* is a thin **core**
concept; audiences attaches delivery to it. (See [temporal facts §9](temporal-facts.md).)

## 14. Out of scope (named so the gap is a choice)

- **Sequencing / funnels** — "pricing **then** demo **within** 2 days." The model is
  set-based, not sequence-based. Separate axis, later.
- **Saved/named selectors as first-class objects** beyond audiences — possible, but
  v2; for now a selector is either run live (analytics) or saved as an audience.

---

**Build order (after [facts](temporal-facts.md)):** core `selector` schema +
`resolve()` (the funnel) + the three projections + `preview()` → **expose QUERY as
REST `/query` `/preview` + MCP** → audiences-on-selector (activation + delivery) →
the **analytics UI** (query builder + segment manager) last. The facts brick goes
in first.
