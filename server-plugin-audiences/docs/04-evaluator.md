# 04 · Evaluator

The evaluator ([`src/evaluator.js`](../src/evaluator.js)) is a **thin adapter (~80 lines) over the core
selector engine** (`ctx.selector`). It used to assemble three bespoke feature families (semantic
vector-narrow, metric SQL gates, crm facts) and run its own LLM judge — a full re-implementation of the
engine's about → filter → judge funnel. All of that is gone (`src/features/*` deleted). The engine now
owns every bit of selection; this module just maps a rule's saved `select` (or `funnel`) onto it.

For the funnel mechanics — `about`, `filter`, `judge`, `preview`, and the `funnel` slot model — read the
selector spec: [`whitebox-pro-server/docs/selector.md`](../../whitebox-pro-server/docs/selector.md).
This doc stays focused on **how the plugin uses the engine.**

## The delegation model

A rule has one of two sources, and each maps to one engine call shape:

```
resolveCohort(rule)                                  # the QUALIFIED cohort, per-member metadata
  select source → selector.resolve(rule.select, { projection: 'people' })
  funnel source → selector.funnel(rule.funnel)  then  selector.funnelSlot(result, rule.slot, { status })
```

The engine resolves the **whole cohort — judge included — in one call.** There is no
candidates-then-judge-each double pass anymore; the plugin asks once and gets back qualified members.
Each member carries `{ id, score, reason, matched_at }` — for a `select` source these come straight from
the engine's `passports` (`p.score`, `p.why`, `p.matched_at`); for a `funnel` source the slot ids are
wrapped with a synthetic `score: 1` / `reason: "funnel <slot>"`.

`service.evaluateRule` calls `resolveCohort` **once**, then records and fires each member — see
[`docs/09-api.md`](09-api.md).

## Single-passport membership (the dirty/incremental path)

```
evaluate(rule, passportId)
  → selector.resolve(rule.select, { projection: 'people', scope: [passportId] })
  → in the result? → verdict(qualified, score=p.score, reason=p.why, { matched_at })
```

`evaluate` is the incremental path: one passport changed, does it still belong? It scopes the same
`select` resolve to that single passport and checks whether the passport comes back. `why` / `score` /
`matched_at` all come from the engine.

**SELECT sources only.** A funnel is inherently a population computation (ordered, windowed steps over a
cohort), so funnel audiences can't be evaluated per-passport — `evaluate` returns a non-qualifying verdict
for them. Funnel audiences keep warm by population re-resolve (`resolveCohort` via `evaluateRule`), never
per-passport. `service.evaluatePassport` already filters funnel rules out of the dirty path.

## Preview = cost, before anything fires

```
preview(rule)
  select source → selector.preview(rule.select)  mapped to:
      candidate_pool    = filter.survivors
      est_matches       = judge.projectedMatches   (or filter.survivors when there's no judge)
      sampled           = judge.sample
      full_scan         = fullScan
      confirm_required  = confirmRequired
      sample_reasons    = judge.reasons
  funnel source → resolveCohort(rule) → { candidate_pool = est_matches = slot cohort size }
```

Preview never fires delivery. For a `select` source it's a straight pass-through of the engine's preview:
the survivor count *is* the judge-call count, plus a sampled qualifying rate, a few real "why" reasons, a
`full_scan` flag, and a `confirm_required` cap. The semantics live in the engine — see selector.md §9. For
a `funnel` source there's no LLM to preview, so we just report the slot cohort size.

## The cost lever still holds — it just lives in the engine now

The two principles this plugin used to implement by hand are unchanged; they simply moved **into the
selector engine**:

- **Cheap narrow before expensive LLM.** `about` gates semantically, `filter` gates deterministically
  (SQL / facts), and the LLM `judge` runs **last, only on the survivors**. Cost is governed entirely by
  how much `about` + `filter` narrowed first. (selector.md §3, §6.)
- **The LLM judges meaning, never counts.** `metric` / `fact` clauses are computed deterministically and
  handed to the judge as structured context — it weighs them, it never recomputes or counts. (selector.md
  §6.)

The plugin no longer owns these knobs. The old plugin-level config (`candidateSimilarity`,
`candidateLimit` under `config.audiences.evaluation`) is gone; the similarity floor and candidate caps are
now engine config (`selector.candidateSimilarity`, etc.). Tune selection in the engine, not here.

## Supporting calls

```
availableFacts()        # distinct fact keys for rule authoring / discovery
  → db('whitebox_facts').distinct('key').orderBy('key')  → [{ key }]
```

`availableFacts` was a bespoke cache; it now reads the core facts table directly — the distinct `key`s a
base actually has, for authoring and discovery.

```
draftRule(description)  # LLM drafts a selector-shaped rule
  → ai.object(system, description, DRAFT)
  → { name, select: { about?, judge?: { criteria, confidence? } } }
```

`draftRule` turns a marketer's natural-language description into a **draft selector**: a short `name`, an
optional `select.about` (comma-separated topics for the semantic search), and an optional
`select.judge.criteria` (one precise membership sentence, `confidence` default `0.7`). It only proposes the
fuzzy parts — structural `filter` (fact / metric) gates are added by hand afterward.

## Determinism for ad spend

AI verdicts are non-deterministic; audiences spend money. The guardrails now sit at two layers:

- **In the engine** — the `judge.confidence` threshold (don't qualify on low confidence), the stored `why`
  reason (every membership is explainable), and the preview confirm-cap (the judge never sweeps an
  unbounded set by accident). selector.md §6, §9.
- **In the plugin** — every verdict's `reason` is stored on the match and surfaced by `explain` (the audit
  trail), and the keep-warm sweep re-confirms still-qualifying members via `evaluate` before re-firing. A
  margin / hysteresis on removal (so a borderline passport doesn't flap in and out each sweep) is the
  natural thing to add in keep-warm.
