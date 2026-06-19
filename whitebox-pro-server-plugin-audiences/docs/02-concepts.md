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

## The three evidence families

A rule's `requires` block declares which families the evaluator must assemble.

### `semantic` — meaning
Vector recall over awareness embeddings. Answers *"are they interested in / worried about X?"*. The
LLM judges this. Can't count or know exact state. Always available.

### `metric` — math
Deterministic SQL aggregates over `whitebox_awareness_exposures` (`count`, `distinct_sessions`,
`sum_dwell_ms`, `recency_days`). Answers *"how often / how recent / how long?"*. Runs as a **hard gate
before** the LLM, so you never pay for an LLM call on someone who structurally can't qualify. Always
available.

### `crm` — state
Generic per-passport facts from the context registry (`plan_tier`, `seat_count`, `mrr`, …). Answers
*"who are they?"*. **Availability is tenant-specific** — only exists if the customer pushes those
facts (see [07](07-crm-integration.md)). That's why rules declare `requires.crm` and `preview`
validates it.

> **The LLM judges meaning; it never counts (metric) or invents state (crm).** That split is the whole
> reason the evaluator assembles features instead of dumping everything into one prompt. See
> [04 · Evaluator](04-evaluator.md).
