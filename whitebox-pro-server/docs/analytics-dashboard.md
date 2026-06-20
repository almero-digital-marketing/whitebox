# The analytics UI — an AI-composable living dashboard

**Status:** Design note — direction, not a build spec. Sits on top of
[selector.md](selector.md) and the *query-as-core-surface* plan (core exposes
QUERY; analytics is the UI). No code.

> **One line:** the analytics UI is a **dashboard an AI agent assembles over MCP** —
> charts and answers, both backed by *queries not snapshots*, so the board stays
> alive after the agent walks away.

---

## 1. A query has three activations

Everything in this system is a **saved query (a [selector](selector.md))** with
something hung off it. There are exactly three things you can *do* with one:

| activation | attach | output | consumer |
|---|---|---|---|
| **audience** | a delivery | push the `people` cohort to ad networks | the ad platform |
| **chart** | a viz spec | render the data | the dashboard |
| **answer** | the synthesis layer | narrate it in prose | the dashboard |

```
audience = saved people-selector + delivery       — deliver it
chart    = saved query          + viz             — chart it
answer   = saved question (+scope) + /ask layer    — explain it
```

Same primitive every time. *Deliver it, chart it, or explain it.* A **dashboard**
is where the agent composes the two **read** activations — charts + answers — into a
report; **audiences** are the **act** activation (a different surface — see
[selector §13](selector.md)).

## 2. Charts — saved query + viz

A chart references a **query, not a snapshot**, so it's **live by construction**: it
re-resolves and pushes updates over the core `connect` (Socket.IO) layer.

```
chart = { title, source: <selector | funnel | named query>, viz, options }
```

Viz follows the query's projection — mostly free:

| query output | viz |
|---|---|
| funnel drop-off report | funnel / bar |
| `people` count | big-number / stat |
| `people` cohort | table |
| `knowledge` evidence | cards / table |
| metric over time *(§5)* | line / area |

## 3. Answers — saved question + the `/ask` layer

An **answer widget** holds the **question** (and an optional scope/selector), not a
frozen string — so it **re-answers as the data moves**. "Why did onboarding
conversion drop this week?" re-answers next week, on its own.

What powers a card that must refresh itself with **no agent in the loop**? The
server-side **`/ask`** layer — the synthesis we made REST-only *"for non-agent
callers, a dashboard"* ([selector §7](selector.md)). This is that dashboard; the
engine for it was specced before the vision was described. Full circle.

A dashboard of **living answers** sitting next to **living charts**.

## 4. The refresh model (the cost gradient, again)

It falls straight out of the selector's cost gradient:

- **Charts** (deterministic — facts / metrics / funnels) → **live**, socket-pushed,
  real-time.
- **Answers** (LLM, via `/ask`) and **judged charts** (LLM `judge`) → **periodic /
  on-demand** — they re-synthesize on a cadence or when poked, because they cost a
  model call.

So the same line that makes the `judge` "the expensive stage" is the line between
the live part of the board and the part that refreshes on a timer.

## 5. The one new engine capability: time-series

Everything above reuses the selector as-is **except trend charts**. A line/area
chart ("weekly signups," "funnel conversion by week") needs the query **grouped by
time bucket** — and `resolve()` returns a *single* result, not a series. So the query
layer gains one capability (noted in [selector §7](selector.md)):

```js
// group a metric into buckets → a series
resolve({ filter: { metric: { content: "purchase", count: {} } } },
        { projection: "knowledge", group: { by: "week" } })
// → [ { bucket: "2026-W10", value: 42 }, { bucket: "2026-W11", value: 51 }, … ]
```

The metric-group-by-time is the cheap, standard path (vs sweeping `asOf` across
buckets, which also works but costs N resolves). That's the only genuinely new
engine bit; the rest is composition.

## 6. Two MCP surfaces — the agent uses both

The separation we've held all along:

- **Core QUERY MCP** (`query`, `preview`) → the **data**. The agent *explores*: "what's
  the onboarding funnel," "how many in this segment," "trend it by week."
- **Analytics-UI MCP** (new) → the **composition**: `create_chart`, `create_answer`,
  `add_to_dashboard`, `arrange`, `update_*`. A UI/presentation concern, so it lives in
  the analytics layer, **not** core — core stays pure data.

The agent is the **author**: it uses QUERY to find the right cut, then the analytics-UI
tools to lay out charts + answer-cards on the canvas. After it walks away, core QUERY
keeps the charts live and `/ask` keeps the answers answered. The board runs itself.

```
agent ──(core QUERY MCP)──►  explore / validate the data
      ──(analytics-UI MCP)─►  create_chart / create_answer / add_to_dashboard
                              │
dashboard  ◄── live charts (socket, core QUERY) + living answers (/ask, periodic)
```

## 7. Where it sits

This is the concrete form of "**analytics becomes the UI**" (the *query-as-core-surface*
plan): the UI is an AI-composable, self-refreshing dashboard over the core QUERY engine
— the **view** half of "view + act," with audiences as the **act** half. It's also the
purest expression of the integration-first "view + act" doc story: ask in plain
language, get a living board back.

## 8. Out of scope (for the note)

- The **viz library / front-end** itself — this note is the model + the surfaces, not
  the React.
- **Incrementally-materialized** live charts (update-per-event vs re-resolve) — a v2
  optimization; v1 re-runs the fast SQL on invalidation.
- Anything in the selector/facts specs already marked out of scope (sequence regex,
  bitemporal).

---

**Net:** the analytics UI = **charts + answers the AI assembles over MCP**, each a
saved query with a viz or the `/ask` layer attached, kept alive by core QUERY and
`/ask`. The only new engine capability is **time-series grouping**; everything else is
composition over [selector.md](selector.md) + [temporal-facts.md](temporal-facts.md).
