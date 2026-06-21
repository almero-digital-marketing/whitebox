# 02 · Concepts

Read this once and the rest of the docs make sense.

## Mode A vs Mode B

There are two ways to turn a segment into an audience on an ad network. **This plugin is Mode A.**

### Mode A — event → audience rule (v1)

You fire a **custom event** (e.g. `wb_enterprise_ready`) with hashed identity. On the platform you
create — **once** — a Custom Audience whose rule is *"people who triggered `wb_enterprise_ready` in
the last N days."* The platform pools, sizes, and ages the audience.

- ✅ low setup (one audience rule per segment), works below min-size (platform pools), zero ongoing
  membership plumbing.
- ⚠️ **no explicit removal** — you stop firing, the platform ages people out by its window; you don't
  know the final audience size.

### Mode B — membership upload (v2)

You create a named audience and **add/remove members directly** with hashed identifiers. Full control
(removal, decay, first-party-only signals), but more setup (audience CRUD, OAuth, min-size buffering).

| | Mode A | Mode B |
|---|---|---|
| segment defined | a rule on your event, on-platform | a member list, in WhiteBox |
| who manages membership | the platform (recency window) | WhiteBox (explicit add/remove) |
| removal / decay | window only | precise |
| small segments | platform pools | blocked by min-size |
| WhiteBox knows | who matched · why · what it fired | the roster + size |

> **Why Mode A first:** zero per-segment membership management, and it works the day you ship — the
> platform does the pooling. Promote a segment to Mode B when you need hard removal or first-party-only
> signals. (Flip `delivery.<net>.mode` to `'membership'` in v2.)

## A rule is a saved selector

A rule no longer carries a `seed` / `criteria` / `requires` block of its own. **Selection moved
to the core selector engine (`ctx.selector`)** — the same predicate analytics reads. A rule is just
a *saved selector* (a people-cohort) with a delivery and a lifecycle attached. It has exactly **one
source**:

### `select` — a core selector
A selector is `{ about, filter, judge }` (at least one):

- **`about`** — a semantic topic, matched by vector similarity over awareness. As a people gate it
  keeps everyone above a similarity floor. Answers *"interested in / worried about X?"*.
- **`filter`** — a boolean tree (`all` / `any` / `not`) of deterministic clauses over the two core
  memories: `fact` (structured state in core facts), `metric` (windowed awareness aggregates —
  `count`, `distinct_sessions`, `sum_dwell_ms`, `recency_days`, `sum`), `channel` / `direction`.
- **`judge`** — an optional LLM predicate (`{ criteria, confidence }`) for nuance the other two
  can't express. It runs **once per candidate that survives `about` + `filter`**, weighing the
  recalled evidence and computed values, and returns `{ match, score }`.

The engine resolves the whole cohort — `about` → `filter` → `judge` — in **one call**, cheapest
stages first, so the expensive judge only ever sees the already-narrowed set.

### `funnel` + `slot` — a funnel cohort
The other source is a **funnel** plus a **slot**: ordered, windowed steps (resolved by the engine),
then the slot picks a people-cohort out of them.

- **`slot: "step:N"`** — that step's completers.
- **`slot: "gap:N→M"`** — the drop-off cohort between two steps, with optional
  **`status`**: `pending` (still inside the window — act now, you can still save them) or `dropped`
  (the window closed — win-back).

The **gap** is the retargeting payoff: *"activated, didn't purchase within 14 days"* → push to
Meta/TikTok. A gap audience is **self-draining** — keep-warm re-resolves the funnel, and as people
convert they leave the gap and the platform ages them out.

> **The evaluator is a thin adapter.** It owns no selection logic — it maps the rule's saved
> source onto the engine: `select` → `selector.resolve(…, { projection: 'people' })`, `funnel` →
> `selector.funnel(…)` + the slot. The engine produces the **why** and **score** for every member.
> See [04 · Evaluator](04-evaluator.md).

## "Matches" are not "membership"

In Mode A, WhiteBox does **not** hold a roster you push. The `whitebox_audience_matches` table is a
**qualification + audit record**: who matched a rule, the AI's reason, and which networks you've
**fired** for (and when). It exists to:

- power **keep-warm** (re-fire before the platform window expires),
- power **explain** (the GDPR "why is this person targeted"),
- avoid re-firing the same person redundantly within a window.

It is *not* the audience. The audience lives on Meta/TikTok/GA4.

## Keep-warm and "removal"

Because Mode A audiences decay by the **platform's** recency window, WhiteBox must **re-fire** the
event for still-qualifying passports on a cadence **shorter than that window** (config:
`evaluation.keepWarmDays`, default 7d; set your audience window to e.g. 30d). The scheduled sweep:

```
for each enabled rule, for each still-qualified match older than keepWarmDays:
   re-evaluate (does it STILL qualify?)
   yes → fire again (refresh the window)
   no  → mark not-qualified, stop firing  →  platform ages it out
```

So **"remove someone from the audience" = stop re-firing.** There is no removal API call in Mode A.

## Audiences you can explain

Every member has a **why**. The selector engine produces it: a `people` resolve returns each
passport with a `why` (the reason it qualified) and a `score`, and the evaluator stores that
alongside the match. A gap cohort's reason is the slot itself (*"funnel gap:2→3"*). So the GDPR
question — *"why is this person targeted?"* — always has a grounded answer, because the engine that
selected them is the same engine that explains them.

That explainability falls out of how the engine narrows: cheap, deterministic stages first, the LLM
last. The split is principled —

> **The judge decides meaning; it never counts and never invents state.** Counting is `filter.metric`
> (windowed awareness aggregates), state is `filter.fact` (structured CRM-sourced facts — see
> [07](07-crm-integration.md)), and only genuine nuance reaches the LLM `judge` — on the already-narrowed
> set. See [04 · Evaluator](04-evaluator.md).
