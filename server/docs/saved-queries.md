# Saved queries — the durable query primitive (core)

**Status:** Spec — decisions SQ1–SQ5 settled (§9). The store the
[selector](selector.md) resolves, that [analytics](analytics-concept.md) widgets
and audiences reference, and that funnel steps name. A **core** primitive (not the
composition plugin's). Builds after the selector engine; no code yet.

> **One line:** every selector/funnel is persisted as a **row**; giving a row a
> **name** is what promotes a private query into a shared library one; **editing a
> shared-backed widget always forks to a private copy**, and only **Publish** writes
> a change back to the shared query — so a chart tweak can never silently re-target
> an audience.

---

## 1. Why it exists

The [three activations](analytics-concept.md#4-three-activations-of-a-query--the-viewact-bridge)
— a **chart**, an **audience**, an **answer** — all hang off the *same* query. For
"define once, reuse everywhere" and the **view→act** bridge to be real, that query
has to be a durable thing both a widget and an audience can point at **by id**. This
is that thing.

It is a **core** store, not the composition plugin's: a chart (analytics) and an
audience (audiences) are different plugins that must share one query, so the query
can't live inside either. Core owns it; both reference it.

## 2. The object

One table. A query is the **predicate only** — the selector or funnel `def`. What you
*do* with it (projection, presentation, a question, a delivery) belongs to the
**consumer**, never the query — consistent with `resolve(selector, { projection,
scope, asOf, group })` in [selector §7](selector.md#7-projections--scope).

```
whitebox_saved_queries (
  id           uuid    pk,
  name         text    null,        -- NULL ⇒ inline (private);  set ⇒ named (library)
  kind         text,                -- 'selector' | 'funnel'
  def          jsonb,               -- the selector or funnel def — the "who / what", nothing else
  forked_from  uuid    null,        -- the named query this inline was detached from (enables Publish)
  tags         text[]  null,        -- light tags (B3); only meaningful once named
  created_at, updated_at
)
```

Projection, `group`, presentation, question, delivery are **not** here — they are
resolve-time arguments the consumer supplies.

## 3. Two states — saved ≠ named  *(restates [analytics B1–B3](analytics-concept.md#7-query-organization-b1b3))*

The whole anti-mess rule is one column:

| state | `name` | where | who sees it |
|---|---|---|---|
| **inline** | `NULL` | persisted, private to its one consumer, **not** in the library | the system (for dedup) |
| **named** | set | the **library** — human-facing, reusable, referenced by many | people |

**Everything is a row** (so the AI can dedup across *all* of them, §7) — but only a
**named** row appears in the library. "Saved" = a row exists; "named" = `name IS NOT
NULL`. Naming is the *only* thing that makes a query shared; nothing auto-accrues.

**Inline = draft; named = published** — the simple binary the word implies:

| widget state | row | badge | |
|---|---|---|---|
| **published** | `name` set | shared/named mark | the library version; **Save** forks edits to a draft (§5) |
| **draft · diverged** | `name NULL`, `forked_from` set | **draft** | local edits ahead of a published query → **Publish** / **Revert** |
| **draft · new** | `name NULL`, no `forked_from` | **draft** | born inline, never published → **Name** it (publish as new) |

Both inline sub-states read **"draft"**; they differ only in *actions* — a diverged
draft can **Publish** (commit its edits up) or **Revert** (discard them); a new draft
can only be **Name**d into a fresh published query. The state is derivable from
`(name, forked_from)` alone; the badge is rendered by analytics.

## 4. Consumers reference a query by id

```
chart widget   { query_id, presentation, group?, ... }      — view (data)
answer widget  { query_id, question }                        — view (prose, via /ask)
audience       { query_id | funnel-slot, delivery }          — act
funnel step     a named-selector ref, or inline
```

- A consumer pointing at an **inline** row **owns** it (1:1) — editing it is local.
- A consumer pointing at a **named** row **shares** it (1:many) — it sees whatever
  that row currently holds. This is where propagation lives (§6).

## 5. The lifecycle — four verbs

Editing opens the editor; the **four verbs** are what you do with the result. The
safety is that the everyday one — **Save** — is local and never propagates:

```
            ┌─ Save ────▶  draft (inline)      keep your edits privately — no propagation; the default
editing ────┤
(a widget)  ├─ Publish ─▶  update the shared query this draft forked from — propagates to every consumer (§6)
            ├─ Name ────▶  a NEW shared query  — publish as new; any source query left untouched
            └─ Revert ──▶  drop the draft       — re-bind to the shared source; no propagation
```

- **Save** — persist the editor's changes as the widget's **draft** (an inline row);
  the safe default for day-to-day tweaks. If the widget was bound to a **named**
  query, Save **forks**: it mints an inline row (`forked_from` = that named id) and
  repoints the widget to it, leaving the named query untouched. If the widget already
  had its own draft, Save updates it in place. **Save never propagates.**
- **Publish** *(diverged draft only)* — copy the draft `def` onto the `forked_from`
  named row, re-bind the widget to it, and propagate to **every** consumer (§6).
  *Update-existing only* — making a *new* shared query is **Name**, not Publish.
- **Name** — promote the draft to a **new** named/library query. On a forked draft it
  **severs the fork** (your version becomes independent; the original is untouched) —
  the "publish as new" door.
- **Revert** *(diverged draft only)* — discard the draft `def`, re-bind to
  `forked_from`, GC the orphan. Publish's discard twin; never propagates.

Four non-overlapping verbs, one sentence each:

| verb | does | propagates? |
|---|---|---|
| **Save** | keep edits as a private draft | no |
| **Publish** | update the shared query it came from | **yes** |
| **Name** | make a new shared query from the draft | (it's new) |
| **Revert** | throw the draft's edits away | no |

Publish and Revert both end with the widget **clean and bound to the shared query** —
they differ only in whether the shared query *absorbed* the edits or *discarded* them.

## 6. Propagation & blast radius

**Only Publish propagates.** A plain Edit forks; the shared query — and therefore
every chart and **audience** that references it — is unaffected until you Publish.

This is what makes the act side safe **by construction**: an **audience** that
references a named query follows it, but the query only changes on Publish, so a
dashboard tweak can **never silently move ad-targeting**. The audience shifts only
when someone explicitly Publishes — exactly the moment they know they're changing
things.

Publish's confirmation says, in one line, *"this updates the shared query everywhere
it's used, including any audiences"* — generic, **no usage count and no where-used
graph** (per [B3](analytics-concept.md#7-query-organization-b1b3)). The word
*Publish* already carries the "it goes out" weight; the confirm just names that audiences
are downstream.

**Removal never cascades.** Deleting a widget, report, or audience GCs only the
**draft** (inline) rows it solely owned; every **named** query stays put. So removing a
report can't delete a query an audience still needs — removal stops at the consumer
boundary. Deleting a *named* query itself is a separate, **guarded** library action (the
same generic *"may be used elsewhere, including audiences"* confirm as Publish), never a
side effect of removing something that references it.

## 7. Dedup — reuse beats minting

Because **inline rows are real rows**, the AI authoring loop searches *all* persisted
queries (inline included) before creating one, and reuses a match instead of minting
a near-duplicate. Reuse is in-context (clone a widget, "make this an audience") or AI
dedup; it **never starts from the library**, so nothing has to be pre-named. Naming
stays a *consequence* of reuse, not a precondition. (Mechanics:
[analytics §7](analytics-concept.md#7-query-organization-b1b3).)

## 8. Surface

Core owns the store and exposes thin CRUD; the composition plugin's authoring verbs
are callers, not a second store:

| core (REST + MCP) | does |
|---|---|
| `save(def, { forked_from? })` | persist a **draft** (inline row); forks from a source when given — no propagation (§5) |
| `name(id, name, tags?)` | promote a draft → **new named** library query (§5) |
| `publish(draft_id)` | write `def` onto `forked_from`, re-bind, propagate, GC (§5–6) |
| `revert(draft_id)` | discard `def`, re-bind to `forked_from`, GC — no propagation (§5) |
| `delete(named_id)` | **guarded** library delete — confirm *"may be used elsewhere, incl. audiences"* (§6); never fired by removing a consumer |
| `get` / `list` (named only) / `search` | fetch & find; `search` backs §7 dedup |

(Draft GC — sweeping inline rows with no consumer — is an automatic background sweep,
not a verb; see §10.)

The analytics composition verbs `save_query_to_library` and the Publish action
([analytics §8](analytics-concept.md#8-the-composition-mcp-surface)) call `name` /
`publish`. Audiences and widgets store a `query_id` and resolve through
[selector](selector.md). No plugin reimplements the store.

## 9. Decisions — settled

| # | decision | ✅ |
|---|---|---|
| **SQ1** | persistence | **every** query is a row; `name IS NULL` ⇒ inline/private, named ⇒ library (saved ≠ named) |
| **SQ2** | edit semantics | editing a **named**-backed consumer **forks to a new inline row** (`forked_from`); the named query is never mutated in place |
| **SQ3** | lifecycle — **four verbs** | **Save** (persist a draft, local — the default) · **Publish** (update the `forked_from` named query, propagate) · **Name** (promote to a *new* named query) · **Revert** (discard the draft) |
| **SQ4** | propagation | **only Publish propagates**; audiences/widgets follow a named query only on Publish → no silent re-targeting. Any **inline** widget reads as a **draft** (vs **published** = named); a *diverged* draft (`forked_from` set) is the one that can Publish / Revert |
| **SQ5** | dedup | AI searches all persisted (inline included) before minting; reuse > duplicate; naming is a consequence, never a precondition |

## 10. Where it sits

```
core        memories + identity + selector engine + SAVED-QUERY STORE   ← this spec
            QUERY resolves a saved query (by id) or an ad-hoc selector
plugins     analytics  — widgets reference query_id; Name/Publish call core
            audiences  — source references query_id (or a funnel slot) + delivery
```

**Build note:** a small core store + CRUD + `name`/`publish` + a `search` for dedup.
It slots into the [selector build order](selector.md#13-where-this-leaves-the-architecture)
right after `resolve()`/`preview()` and before audiences-on-selector — audiences need
a `query_id` to point at. The composition plugin and audiences are *callers*; neither
owns the store.
