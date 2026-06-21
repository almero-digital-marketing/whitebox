# Identity merge — detect & forget (plan)

**Status:** Plan — not yet built. Grounds on the current merge in
[`src/passports.js`](../src/passports.js) (mechanics solid). Scope: **detect a corrupted
passport and `forget` it**, plus a **conservative merge default** — *not* root-cause
logging, *not* surgical un-merge, *not* the heuristics (real data owns those, §6).

> **One line:** don't track *why* a merge went wrong — the failure modes are already
> well known and the history isn't actionable. Detect *when a passport has become two
> people* — from its **current shape** — and `forget` it. Detection + forget, over
> forensics + repair.

---

## 1. Principles

- **P1 · Detect corruption, don't trace it.** A merge's root cause isn't actionable: the
  failure modes are known, and you can't usefully un-pick one specific bad merge. What
  *is* actionable is spotting a passport that's quietly become 2+ people — visible in its
  **present state**, not its merge history. So invest in **detection + `forget`**, not a
  merge-decision log.
- **P2 · Conservative at *both* gates — merge and forget are each destructive, in
  opposite directions.** Over-merge corrupts memory and exposes one person under another.
  But `forget` *deletes* — so a **false** corruption-detection nukes a healthy customer.
  So: **decline** ambiguous merges, and only **auto-forget** on near-certain corruption.
  Don't trade an over-merge problem for a deleted-good-data problem.

## 2. Current state

**Solid (keep the mechanics):** `merge()` is transactional, catalog-driven, chain-compacting
(`src/passports.js:159-212`); `resolve()` forwards absorbed → survivor (`:72-79`); strong
identities globally unique, weak per-passport (`:30-68`).

**The actual gap is a *detector*** — there is no check that asks "does this passport look
like more than one person?" Everything else I'd considered (decision log, link-event log,
reversal journal, un-merge) is **out of scope**: not actionable, or replaced by `forget`.

## 3. The corruption signal — read from current shape

A corrupted passport is one that's silently fused 2+ people. You see it in its **state**,
which is exactly why merge history doesn't help:

| signal | what it is | confidence |
|---|---|---|
| **contradictory immutable facts** | two `birthdate`s / `country`s / legal names that can't be one person | **hard** — near-certain |
| **impossibility** | activity in two places at once; velocity violations | **hard** |
| **identity multiplicity** | many strong identities where a person has ~one (≥N emails / phones / fingerprints) | **soft** — legit power-users exist |

These are the "well-known verticals" — naming them needs no data; only their **thresholds**
are distribution-tuned (§6).

## 4. Two hooks, one signal

The same signal applies at two moments:

- **Prevent — at merge time.** A merge that would push a passport over the signal
  **declines** (leaves the passports apart) rather than fusing. This is the main line of
  defence (P2): most corruption never forms. Refactor the implicit
  `if strong && within-lifespan` (`:137`) into a seam
  `evaluateMerge(event, candidate) → { merge, reasons[] }` so a guard can veto.
- **Detect — over existing passports.** A sweep (background job, or a check after each
  merge) flags passports already showing a **hard** signal → `forget`. Catches what
  prevention missed or what predates it.

## 5. Remediation = `forget`, gated by confidence

`forget` (the existing GDPR delete) removes the conflated passport's awareness, killing the
exposure. Because it's destructive, the gate is **confidence**, not a repair queue:

- **Hard signal → auto-`forget`.** Contradictory immutable facts / impossibility are
  near-certain corruption — safe to act on automatically.
- **Soft signal (multiplicity) → prevention only.** It **declines the merge** at write
  time but does **not** auto-forget an existing passport — auto-nuking on "has 5 emails"
  would delete legit users. Whether soft detection ever earns a confirm-gate is **deferred**
  until real data shows how much corruption actually slips past prevention.

Honest cost, stated: `forget` is **blunt** — it deletes the innocent party's swept-in
history too. That's tolerable only because P2's prevention keeps over-merges rare, and
because we restrict auto-forget to near-certain cases. We are explicitly **not** building a
clean split that separates the two people's data back apart; if a case needs it, it's a
manual op, not a feature.

## 6. Deferred — thresholds, heuristics, replay *(real-data-owned)*

Not now; arrives with real data and plugs into the §4 seam:

- **threshold tuning** for the multiplicity signal (how many emails is "too many" for *your*
  base);
- the merge **heuristics**: per-type confidence (`user` ≫ email ≫ fingerprint; verified ≫
  typed), **decay curves** replacing hard lifespans, session co-occurrence, transitivity
  caps + corroboration, negative evidence, velocity;
- **replay-based tuning** — *if ever pursued*, it needs an append-only link-event log to
  re-run rules over history. That log is the one thing with a **start-now-or-lose-history**
  property, but it's deferred by default: start it only when you decide tuning-on-history is
  worth it. New activity re-accrues a forgotten passport regardless, so it isn't needed for
  detect+forget.

## 7. Storage stays physical

With no surgical un-merge to support, the physical-vs-logical merge question is **moot**: the
current physical merge (repoint FKs) stays — it works, it's tested, and `forget` is the
remedy. Revisit a logical (read-time-edge) merge *only* if `forget`'s collateral proves
unacceptable at real over-merge rates. Decided by data.

## 8. Build order

```
Now            corruption signal (§3) ── two hooks (§4):
                 · decline-at-merge   (prevent — the main defence)
                 · hard-signal sweep  → forget (detect + remedy)
Deferred       multiplicity thresholds · heuristics · (replay, if ever)
```

Fold in while here: the **silent unique-constraint swallow** (`src/passports.js:130`) should
log a strong-identity race, not swallow it.

**The cut:** the near-term work is one thing — a **corruption detector** wired to `forget`,
plus a decline-guard at merge time. No logs to nobody reads, no reversal, no repair. You spot
a passport that's become two people and you delete it; you stop the obvious bad merges before
they happen; everything else waits for real data.
