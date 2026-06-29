# Scoped + windowed population recall — ground the generative answer in a structured cohort

**Status:** Proposal. Touches **core** (`awareness/ask.js`, `awareness/query.js`, `awareness/store.js`). Core-owned — this is the contract to hand over. The analytics composition layer is the consumer (and is already half-wired for it). See [selector.md §7](selector.md) ("answer is a layer above the engine"), [event-attributes.md](event-attributes.md).

---

## 1. The problem

The analytics compose layer now **decomposes** a question into a structured query — WHO (filter) · WHEN (window) · SPLIT BY (dimension) · MEASURE — and only falls back to the generative `answer` path for the **irreducibly qualitative residual** ("what are people complaining about", "themes in consultation calls").

But that residual is still ungrounded. The `answer` widget calls `askPopulation({ question })`, and **`askPopulation` / `population()` / `populationStats()` take no scope and no time window** — they run semantic recall + base aggregates over the **entire base, all time**. So a qualitative answer cannot be confined to "active customers" or "last month."

That contradicts the selector spec's own contract ([selector.md §7](selector.md)):

```
answer = synthesize(question, query(scope, window, knowledge))
```

The answer is supposed to sit **on top of** a structured `query` — consuming its cohort + window — not run wide open over everything.

---

## 2. The concrete gap

```
askPopulation({ question, similarity, limit, sample, instruction, schema })   // ask.js — no scope, no window
  → population({ query, similarity, limit })                                  // query.js — no scope, no window
      → populationChunks({ embedding, similarity, limit })                    // store.js — vector search over ALL exposures
  → populationStats()                                                         // store.js — whole-base aggregates
```

None of these accept a passport scope or a `ts` filter. The vector search and the grounding aggregates both span the whole base.

---

## 3. The ask

Thread two optional params through the population path — additive, backward-compatible:

- **`scope`** — a passport-id array; restrict recall **and** the grounding stats to that cohort.
- **a time window** — `last: "30d"` (or `from: <ISO ts>`); restrict evidence to recent activity.

Plumbing:

| layer | change |
|---|---|
| `askPopulation({ …, scope, last })` | pass `scope` + `last` to both `population` and `populationStats` |
| `population({ query, similarity, limit, scope, last })` | forward to `populationChunks` |
| `populationChunks({ …, scope, last })` | SQL: `AND passport_id = ANY(?)` (when scope) · `AND ts >= ?` (when window) — both bound, both optional |
| `populationStats({ scope, last })` | same two filters, so the base aggregates the answer is grounded on **match the cohort/window** (otherwise the LLM sees "12,000 customers" while answering about 43) |

`last` uses the same window grammar as the selector metric (`7d`/`30d`/`2w`).

---

## 4. The analytics contract (already half-wired)

The `answer` widget query gains `scope` (a **people sub-selector**) + `last`/`from`:

```json
{ "question": "What are active customers complaining about?",
  "scope":    { "filter": { "fact": { "client_status": { "eq": "active" } } } },
  "last":     "30d" }
```

`runQuery` **already resolves a `scope` sub-selector to passport ids** (added for scoped breakdowns/timeseries — `composition/routes.js`). It would resolve the cohort, then call `askPopulation({ question, scope: ids, last })`. The compose prompt then emits `scope` + `last` on the residual qualitative `answer` widgets — so "what are active customers complaining about, last month" is grounded in (active cohort, 30 days), and the LLM does only the qualitative synthesis.

---

## 5. Scope & ownership

| change | where | owner |
|---|---|---|
| `scope` + `last` on `askPopulation` | `awareness/ask.js` | **core** |
| forward through `population` | `awareness/query.js` | **core** |
| `passport_id`/`ts` filters in the SQL | `awareness/store.js` (`populationChunks`, `populationStats`) | **core** |
| pass cohort ids + window from the `answer` widget; teach compose to emit them | `server-plugin-analytics` | analytics (here) |

All core changes are **additive** — existing `askPopulation({ question })` callers are unaffected (scope/window default to "whole base, all time").

---

## 6. Why this completes the architecture

Same pattern as [event-attributes.md](event-attributes.md): the generative layer **composes on top of** structured selection rather than replacing it. With both in place the division is clean and the agent's job is well-defined:

- **Structured selection** answers *who / what / when / how-many / split-by* — deterministic, auditable, reproducible. This should be **almost everything**.
- The **generative answer** handles only the irreducible qualitative residual (themes, sentiment, free-form "why") — and even then it runs **inside the structured scope + window**, never wide open.
