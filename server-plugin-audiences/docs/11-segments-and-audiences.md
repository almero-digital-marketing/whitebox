# 11 · Segments, audiences & activation

**Status:** Design — the evolution of the [rule](03-rules.md) model into a shared
targeting layer. Segments and audience-composition are new; ad-network delivery
([02](02-concepts.md), [05](05-networks.md)) is unchanged and becomes *one* activation.

> **One line:** a **segment** is a named, dynamic sub-query born from a chart selection;
> an **audience** is an `AND/OR/NOT` composition of segments; both are **living queries**
> (resolved at apply-time, never a stored roster). An audience is the **single
> activation-agnostic targeting primitive** that every consumer points at — ad-network
> **CAPI delivery** *and* the **campaigns** module (email/SMS) alike.

---

## 1. Why this exists — un-bundle the cohort from the activation

Today a [rule](03-rules.md) bundles two things: a cohort (a saved selector / funnel-slot)
**and** an ad-network delivery. That's fine when ad networks are the only consumer. They
aren't: the **campaigns** module targets email/SMS at the *same* cohorts.

So we split the two:

| layer | what it is | who owns it |
|---|---|---|
| **segment** | one chart-derived dynamic sub-query (the atom) | this plugin |
| **audience** | an `AND/OR/NOT` composition of segments — **activation-agnostic** | this plugin |
| **activation** | how an audience is *used*: ad-network CAPI **delivery**, or a **campaign** send | the consumer (audiences / campaigns) |

The old "rule" is now just **a single-segment audience + an ad-delivery activation** — it
keeps working (§7), but the cohort it targets is no longer welded to ad networks.

```
analytics (a chart selection)
        │  derive
        ▼
   SEGMENT ──compose (AND/OR/NOT)──▶ AUDIENCE ──┬─▶ ad-network delivery (CAPI, Mode A)
   (dynamic, named, dedup'd)        (dynamic)   └─▶ campaign send (email / SMS)
        └──────────── resolved LIVE at apply-time ───────────┘
```

## 2. Segment — the atom

A segment is a **saved core selector source**, exactly like a rule's source, but with **no
delivery and no lifecycle of its own** — it's a reusable cohort fragment.

```js
segment {
  id,                       // uuid
  name,                     // AI-generated, human-facing ("Lapsed clients", "Opened, didn't click")
  source: { ... },          // SELECTOR  { select: {about?, filter?, judge?} }
                            //   OR  FUNNEL-SLOT { funnel, slot:'gap:2→3', status? }
  predicate_key,            // deterministic stable-hash of source → dedup identity
  origin,                   // provenance: { widget_id?, report_id?, selection } (optional)
}
```

- **Born from a chart selection** (§6). The user clicks a bar; the system derives the
  predicate, the AI names it, the **query stays hidden** in the UI — you see a named chip.
- **Dedup on `predicate_key`**, not the name: selecting the "lapsed" bar twice yields the
  *same* segment. The AI name is a cached label over a deterministic identity.
- The `source` is resolved by the **core selector engine** — `select` →
  `selector.resolve(…, {projection:'people'})`, `funnel` → `selector.funnel(…)` + the slot.
  This is the exact resolution the [evaluator](04-evaluator.md) already does for rule sources.

## 3. Audience — the composition

An audience is a **flat boolean combination of segments**, plus zero or more activations.

```js
audience {
  id, name,
  composition: { op: 'all' | 'any', members: [ {segment_id} | {not: segment_id} ] },
  activations: [ … ],       // §5 — ad delivery and/or campaign; may be empty (defined, not yet activated)
  ttl_days, policy,         // carried per activation that needs them (ad delivery)
}
```

`all` = AND, `any` = OR, `{not: …}` = NOT a member. **Flat only** — no nested trees in v1
(it covers the overwhelming majority and keeps the builder simple).

An audience with an **empty** `activations` list is legal: *defined and sizeable, not yet
firing* — the analog of a `rule { enabled:false }`. You attach a CAPI event or a campaign
later.

## 4. Dynamic, never a roster

Membership is **never materialized**. An audience holds the *rule*; "who is in it" is a
**live read** computed whenever it's applied:

- **server-side, on input change** — `awareness.recorded` (and, see §8, CRM **fact** changes)
  → `markDirty` → debounced evaluate → activations fire the delta. This is why delivery is
  server-side CAPI: most membership movement happens **off-site, with no browser session**
  (a CRM fact flips and ages someone in/out). See [02 · keep-warm](02-concepts.md).
- **at activation time** — a campaign resolves its audience to recipients **at send/schedule**.

`whitebox_audience_matches` stays a **qualification + audit** record (who matched, the
*why*, what fired) — for keep-warm, explainability, and dedup. It is **not** the audience.

### Resolution — two paths
- **All-`select` (filter) members** → compile the composition into **one** selector
  `filter: { all | any | not: [ …each segment's filter… ] }` and resolve in a single engine
  call. `AND` can also chain via `scope` (resolve B within A's ids). Preview, keep-warm, and
  the per-member *why* all work unchanged.
- **Any funnel-slot or judge member** (can't be a single `filter`) → resolve **each segment
  to a live id-set**, then apply **set algebra** (`∪` / `∩` / `∖`). Uniform and correct for
  every segment kind; the all-filter compile above is just an optimization.

## 5. Activation — the consumers

An audience is activation-agnostic; an **activation** binds it to a channel. Same cohort,
different identity projection and consent surface:

| activation | resolves the cohort to | identity needed | consent | suppression |
|---|---|---|---|---|
| **ad delivery** (CAPI, Mode A) | hashed signals fired as a custom event | **hashed** email/phone + click-ids (`identity.resolve`) | marketing | platform window |
| **campaign** (email / SMS) | a recipient list at send time | **contactable** email/phone (raw, from `passports.identities`) | email / SMS channel consent | unsubscribes / bounces |

Key point: ad delivery wants **hashed** PII (privacy-preserving match keys); a campaign
needs the **actual** address to send. Both start from the same `people` resolve (passport
ids + why); they differ only in the identity projection applied after. The campaigns plugin
owns its send/scheduling; it **references an audience by id** and never re-implements
selection.

## 6. Chart selection → segment (per chart)

The heart of the feature: translate a visual selection into a predicate. Covered kinds and
their derivation:

| chart | selection → source |
|---|---|
| breakdown / donut | bucket value → `select.filter: { <dim> = value }` |
| drop-off / funnel | the bar's transition → `funnel` + `slot: 'gap:i+1→i+2'` (`step:N` for a step) |
| distribution | a bin → `select.filter: { fact ∈ [lo, hi) }` |
| heatmap | a cell → `all: [ row-value, col-value ]` |
| scatter | a **box** brush → `all: [ factX ∈ [x0,x1], factY ∈ [y0,y1] ]` (range predicate — stays dynamic; a freeform lasso can't) |

**No selection** on cohort or timeseries (their cell/point predicates are ambiguous). The
cheapest first slice is **drop-off**, because `selector.funnelSlot(result, slot, …)` already
returns that exact cohort.

## 7. Mapping to the existing plugin (back-compat)

- A **segment** = a rule `source` (select | funnel-slot) extracted into its own row, minus
  delivery. New table `whitebox_audience_segments`.
- An **audience** = the generalization of a rule: a *composition* of segment refs +
  activations. A legacy `rule` ≡ a **one-segment audience** whose single activation is its
  ad `delivery`. The strict one-source rule schema ([03 §validation](03-rules.md)) becomes the
  degenerate case; existing rows migrate as single-segment audiences.
- The **evaluator** gains a *compose* step (§4) in front of its existing source→engine
  mapping; **delivery, matches, keep-warm, consent, identity stay as-is**.

## 8. Open items to verify when implementing

- **CRM fact-change → re-evaluate.** The dirty path subscribes to `awareness.recorded` only
  ([`src/index.js`](../src/index.js)). For CRM-driven audience changes to fire promptly (not
  just at the next keep-warm sweep), a **fact-change** event must also trigger `markDirty`.
- **Channel consent for campaigns.** Ad delivery gates on `marketing` ([08](08-consent-privacy.md));
  email/SMS need their own channel consent + unsubscribe suppression — the campaigns plugin's
  concern, but it should reuse this plugin's consent/suppression tables where they line up.
- **Segment store home.** Segments live in this plugin for now; if analytics widgets and
  audiences later need to share a query by id, promote to the core
  [saved-query store](../../server/docs/saved-queries.md). Not required for v1.

## 9. Build order

1. **Segment primitive** — `whitebox_audience_segments` table + store + `resolveSegment`
   (selector / funnel-slot → ids) + REST (`/audiences/segments` CRUD + preview size + AI name).
2. **Chart selection → segment** in analytics — start with **drop-off** (free via
   `funnelSlot`): select a bar → named segment chip + Save in the insight column.
3. **Audience composition** — generalize the rule to a segment composition + the set-algebra
   resolve; migrate existing rules as single-segment audiences.
4. **Audiences module** (UI) — segment list + the AND/OR/NOT builder; activations (CAPI today,
   campaign later).
5. **Campaigns module** consumes an audience id as its recipient targeting (separate plugin).
