# The selector — one query for read *and* segment (core)

**Status:** Spec — decisions S1–S5 settled (§12). Sits on top of
[temporal facts](temporal-facts.md). Ready to build, no code yet.

> **Naming.** A **selector** is the shared predicate ("who / what"). A
> **projection** is what you ask back — `knowledge` or `people` (answering is a
> *layer on top*, not a projection — §7). An **audience** is a saved *people*
> selector with a delivery attached. Analytics *reads* a selector; audiences
> *activates* one — same query, different verb.

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
//   projection: "knowledge" | "people"             (the engine retrieves; it never writes prose)
//   scope:      "passport" | "base" | a candidate set   (people is always base; a set feeds funnel steps)
//   asOf:       a point in time                     (defaults to now)
//   answer is NOT a projection — it's a layer ABOVE the engine (§7).
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
| `ask(passport, question)` | the **`/ask`** layer → `query(about, knowledge)` + synthesis (§7) |
| an audiences `rule` | `selector` + delivery (saved people projection) |

## 3. Resolution — the funnel

Resolving is a funnel: cheap stages narrow before expensive ones, and `asOf`
threads through every memory read.

```
resolve(selector, { projection, scope, asOf })

  scope ─► 1. about    (semantic narrow + rank)        reads AWARENESS  vector  ← cheap-ish
           2. filter   (boolean gates)                 reads FACTS + AWARENESS  ← cheap (SQL)
           3. judge    (LLM predicate, optional)        per surviving candidate  ← EXPENSIVE
           4. project  (knowledge | people)              ← answer is a layer above (§7)

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

The query engine **retrieves data — it never writes prose.** Two projections:

| projection | returns | scope | REST | MCP |
|---|---|---|---|---|
| `knowledge` | ranked content / evidence (chunks) | passport or base | ✅ | ✅ |
| `people` | `{ count, passports: [{ id, why, matched_at? }] }` | base only | ✅ | ✅ |

The selector is identical for both; the projection is *what you ask back*, not part
of the predicate. A `people` projection saved + given a delivery **is an audience.**

#### `matched_at` — the funnel anchor

Each person in a `people` result carries an optional **`matched_at`** — the
timestamp of the *qualifying event*. Funnels (§14) read it to order and window
steps:

- **Defined** for deterministic steps — the threshold-crossing `metric` event, a
  `fact`'s `observed_at`.
- **Null** for `about` / `judge` — a fuzzy or LLM match has no clean event time, so
  these can't anchor a windowed step (they still work as plain membership).

### `answer` is a layer on top, not a projection

Answering a natural-language question is `synthesize(question, query(…, knowledge))`
— it *consumes* the `knowledge` result and **generates** prose, so it lives one
layer **above** the engine, never inside it. The distinction that keeps this clean:

- **`judge` = LLM as a *predicate*** — decides membership (a boolean per candidate).
  That's *selection* → it belongs **inside** the engine.
- **`answer` = LLM as a *generator*** — writes prose over results. That's *synthesis*
  → it belongs **above** it.

**Rule: the engine may use an LLM to decide *who/what is in*, never to *write about*
the result.** Answering surfaces as a thin REST **`/ask`** for non-agent callers (a
dashboard, a "summarize this customer" button). There is **no MCP `/ask`** — an MCP
client is already an LLM agent, so it takes `knowledge` and answers in its own
context (the `query` tool's description says so). The core query engine never knows
about answering.

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
resolve({ about: "pricing, plans" }, { projection: "knowledge", scope: "passport", passport: "p1" })
//   ↑ a natural-language answer = the /ask layer calling this, then synthesizing (§7) — not a projection

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

- analytics `recall`/`population`/`timeline` → `resolve(selector, { projection, scope })`
  (knowledge / people), old params kept as aliases. `ask` → the **`/ask`** layer
  *above* the engine (`resolve(…, knowledge)` + LLM synthesis), REST-only.
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
           ├── QUERY → REST /query · /preview  ·  MCP query · preview   (retrieves: knowledge | people)
           └── /ask  → REST only — a thin layer over QUERY(knowledge) + LLM synthesis
                       (no MCP /ask: the agent IS the answer layer)

plugins    write     (mail / sms / voip / engagement / conversions / crm → the two memories)
           activate  (audiences → save a people-selector + delivery + keep-warm)   [backend]

analytics  the UI — query builder + segment / audience manager, over core QUERY + audiences
```

So **core exposes QUERY** (resolve → knowledge | people; answering is a layer on
top) as REST + MCP;
**analytics becomes the UI** (build → preview → save-as-audience — the "view + act"
console); **audiences stays the activation backend** (the data-egress boundary:
networks, consent, keep-warm). A *saved selector / segment* is a thin **core**
concept; audiences attaches delivery to it. (See [temporal facts §9](temporal-facts.md).)

## 14. Funnels (v1)

Most funnels need no special machinery — they're a single selector:

- *did A, not B* → `{ all: [ A, { not: B } ] }`  (set difference, via the S2 `not`)
- *did A and B* → `{ all: [ A, B ] }`             (intersection)

The case that **does** need machinery is **windowed / ordered** steps — *"started a
trial, then purchased within 14 days **of starting**"* — because `not B` means
"never B," not "B in the window after A."

### Shape

```js
funnel = {
  within: "30d",                           // OPTIONAL funnel-level total window from entry; default: none
  steps: [
    { select: trialStarted },              // step 1 — the entry
    { select: activated,  within: "7d" },  // step 2 — within 7d of step 1's match
    { select: purchased,  within: "14d" }, // step 3 — within 14d of step 2's match
  ],
}
```

Two kinds of window, and they compose:

- **`step.within`** — **relative to the previous step**; the anchor **advances**, so
  step *k*'s clock starts at step *k-1*'s `matched_at`. (Step 3's 14d is from
  *activation*, not from *trial*.) Total funnel duration is unbounded by default — it's
  the sum of the step windows.
- **`funnel.within`** *(optional)* — a **fixed** total window from the **entry** (step-1
  match), checked at the end: a completer's final `matched_at` must be ≤ `entry +
  within`. Use it when overall velocity matters, not just step-to-step.

### Resolution

Step 1 resolves to a cohort (each person with `matched_at`). Step *k* resolves
**scoped to step k-1's cohort**, keeping only those whose event is *after* the prior
step's `matched_at` and within `step.within`, advancing the anchor. At the end, if
`funnel.within` is set, drop completers whose total span exceeds it. Steps are
**named selectors** (reusable) or inline; windowed steps must be **deterministic**
(event/fact — that's the `matched_at`); `about`/`judge` steps work only as
un-windowed membership.

### Worked example

The funnel above, over six people:

| passport | trial | activated | purchased |
|---|---|---|---|
| p1 | Mar 1 | Mar 3 | Mar 10 |
| p2 | Mar 1 | Mar 4 | **Apr 20** |
| p3 | Mar 2 | **Mar 15** | — |
| p4 | Mar 2 | — | — |
| p5 | Mar 5 | Mar 6 | Mar 8 |
| p6 | — | — | — |

- **Step 1 · trial** (base) → `{p1,p2,p3,p4,p5}`, anchor = trial date. (p6: no trial.) → **5**
- **Step 2 · activated ≤7d of step 1** → p3 activated Mar 15 > Mar 9 ✗, p4 never ✗ → `{p1,p2,p5}`, anchor → activation date → **3**
- **Step 3 · purchased ≤14d of step 2** → p2 bought Apr 20 > Mar 18 ✗ → `{p1,p5}` → **2**

*(With `funnel.within: "30d"`, both completers still qualify — p1 spans 9 days, p5 spans 3.)*

**Drop-off report** (`knowledge`):

| step | count | step conv. | overall |
|---|---|---|---|
| 1 · trial | 5 | — | 100% |
| 2 · activated ≤7d | 3 | 60% | 60% |
| 3 · purchased ≤14d | 2 | 67% | 40% |

**Gap cohorts** (`people` → audiences):

- **gap 1→2 = `{p3, p4}`** — started a trial, didn't activate within 7d → onboarding nudge.
- **gap 2→3 = `{p2}`** — activated, didn't purchase within 14d → win-back within the window.

**Why it needs the machinery:** p2 and p3 both *did the events*. An unordered
`{ all: [trial, activated, purchased] }` would call **p2 converted** — the funnel
flags it as a **drop-off** (purchase 47 days late). An unordered `{ all: [trial,
activated] }` would count **p3 activated** — the funnel **drops** it (activated 13
days after trial, outside the 7d window). "Did it, but not *in time*" is exactly what
`matched_at` + the temporal join capture — and where the retargeting audiences live.

### Outputs & hooks

Both outputs are projections: the **drop-off report** is `knowledge`; the per-step and
**gap cohorts** are `people` (each gap saveable as an audience). Enabling hooks, **live
in v1**: `matched_at` on the `people` result (§7), and **`scope: a candidate set`** on
`resolve()` (feed a step's cohort to the next).

### Out of scope

- **Arbitrary sequence / path matching** beyond "next step within a window" (event
  regex, branching paths) — funnels are linear ordered steps.
- **Bitemporal facts** — `asOf` is valid-time by decision [D2](temporal-facts.md);
  unchanged.

---

**Build order (after [facts](temporal-facts.md)):** core `selector` schema +
`resolve()` + the two projections (`knowledge` | `people`, with `matched_at`) +
`scope: set` + `preview()` + **funnels** (ordered named-selector steps + temporal
join + drop-off report) → **expose QUERY as REST `/query` `/preview` + MCP**, plus
the thin **`/ask`** layer (REST) → audiences-on-selector (activation + delivery) →
the **analytics UI** (query builder + segment manager) last. The facts brick goes
in first.
