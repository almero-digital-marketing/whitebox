# Audiences Plugin

> Build ad-network audiences from what WhiteBox knows about each person — save a core **selector** (or a funnel slot), let the engine resolve the cohort, and the plugin fires a custom event to Meta, TikTok and Google (GA4), which build the audience.

## What it is

Save a segment as a core **selector** — or source it from a **funnel slot** → the engine
(`ctx.selector`) resolves the qualified people-cohort, carrying a per-person *"why"* → the plugin
reports a custom event to **Meta, TikTok and Google (GA4)**, and the platforms build the audience.

## Why this exists

A pixel sees one channel and one session. WhiteBox sees the **whole person** — every paragraph they
read, every call they had, every email they opened, plus CRM state — as one queryable memory. This
plugin turns that memory into **ad audiences you can explain**, instead of ones a network guesses at.

You target on **understanding**, and every person in an audience has a human-readable *"why."*

## How it works (Mode A)

Selection lives in **core**. The plugin no longer does its own matching — it **stores a saved
selector, resolves it via the engine, and activates (delivers) the cohort.** The evaluator is now a
thin adapter over `ctx.selector`.

```
 the two core memories  (awareness + facts)
        │
        ▼
   ctx.selector  ──  resolve(rule.select)  →  qualified people-cohort
        │            about → filter → judge  (per person: why · score · matched_at)
        │            ── OR ── funnel(rule.funnel) → slot(rule.slot)  (a step's completers, or a gap)
        ▼
   the plugin:  record the match  +  fire a custom event
        │            ──▶ { Meta CAPI · TikTok Events API · GA4 Measurement Protocol }
        ▼
   the platform builds + ages the audience from a rule on your event
```

**This is Mode A.** WhiteBox fires events and keeps them warm; **the platform owns the audience, its
size, and its decay.** WhiteBox knows *who matched, why, and what it fired* — not a membership roster.
(Direct membership upload — Mode B — is a v2 upgrade. See [docs/02-concepts.md](docs/02-concepts.md).)

## A rule is a saved selector

A rule has **exactly one source** — a `select` (a core selector) or a `funnel` slot — plus delivery
and lifecycle. The engine owns all selection; the rule just names what to resolve and where to fire.

```js
{ id: "enterprise_ready", name: "Ready for Enterprise", enabled: true,

  // SOURCE A — a core selector (about → filter → judge; see the selector spec)
  select: {
    about:  "SSO, security, scale, seat limits",                    // semantic narrow — gates people
    filter: { all: [ { fact: { plan_tier: { eq: "pro" } } },        // boolean tree over core facts…
                     { metric: { content: "pricing", count: { gte: 1 }, last: "30d" } } ] }, // …+ metrics
    judge:  { criteria: "genuinely evaluating an Enterprise upgrade", confidence: 0.7 },     // LLM predicate
  },

  ttl_days: 30, policy: "non_sensitive",
  delivery: { meta: { event: "wb_enterprise_ready" }, tiktok: { event: "wb_enterprise_ready" } } }
```

The selector's three stages map cleanly to the old fields — `seed → select.about`,
`criteria → select.judge.criteria`, `threshold → select.judge.confidence`,
`requires.metric → filter.metric`, and **CRM state is now core facts**: `requires.crm → filter.fact`.

- **`about`** — a semantic topic that *gates* the cohort (similarity floor), not just ranks.
- **`filter`** — a boolean tree (`all`/`any`/`not`) of deterministic `fact` + `metric` clauses.
- **`judge`** — an optional LLM membership predicate `{ criteria, confidence }` for the nuance the
  other two can't express. It judges *meaning*; it never counts (`metric` does) or invents state
  (`fact` does), and it runs **last**, only on what `about` + `filter` already narrowed.

The engine resolves the whole cohort — judge included — in **one call**, and each person comes back
with a `why`, a `score`, and (for deterministic matches) a `matched_at`. The plugin records that and
fires; the "why" you preview is the "why" you deliver. Full spec: the core selector doc; adapter
details: [docs/04-evaluator.md](docs/04-evaluator.md).

### Sourcing from a funnel (retargeting)

A rule can source from a **funnel slot** instead of a plain selector — the retargeting payoff. The
engine resolves the ordered, windowed funnel; the rule picks a slot:

```js
{ id: "activated_not_purchased", name: "Activated, didn't buy", enabled: true,

  // SOURCE B — a funnel slot
  funnel: { within: "30d", steps: [
    { select: "trial_started",            name: "trial" },
    { select: "activated", within: "7d",  name: "activated" },
    { select: "purchased", within: "14d", name: "purchased" } ] },
  slot:   "gap:2→3",          // "did step 2, didn't do step 3 within the window" → retarget
  status: "pending",          // still inside the window (act now) — vs "dropped" (window closed)

  ttl_days: 30, policy: "non_sensitive",
  delivery: { meta: { event: "wb_winback" } } }
```

`slot` is `"step:N"` (that step's completers) or `"gap:N→M"` (the drop-off cohort); `status`
(`pending` | `dropped`) only applies to a gap. A gap audience **self-drains**: keep-warm re-resolves
the funnel, so as people convert they leave the gap and stop being re-fired.

## Install

```bash
npm i whitebox-pro-server-plugin-audiences        # workspace-linked in this monorepo
```

Add it to your `whitebox.config.js` and set the secrets (all from `process.env`):

```js
plugins: ['engagement', 'analytics', 'audiences']
```

See [`whitebox.config.example.js`](whitebox.config.example.js) and [docs/10-deployment.md](docs/10-deployment.md)
for the full config + env vars.

---

# Talk to it (MCP)

The plugin registers MCP tools behind your `/mcp` auth secret, so an agent can author, preview, run,
and explain audiences conversationally. The loop is always **describe → preview (size · cost ·
reasons) → refine → commit → fire → explain.** Below are real sessions (numbers invented).

### 1 · Build a segment from one sentence

> **You:** Retarget our best self-serve accounts who look ready for **Enterprise** — usage limits,
> SSO/security interest, maybe asked about it on a call. Push to Meta and TikTok.

> **Claude:** Checking networks and what identity we can match on.
> ```
> → audiences_network_status {}
> ← meta:{event,eligible:true,coverage:0.74}  tiktok:{event,eligible:true,coverage:0.69}
>   google:{event,transport:"ga4",eligible:false,reason:"GA4 stream not configured"}
> ```
> Meta + TikTok ready; Google's GA4 isn't wired, so I'll skip it. Drafting a selector and previewing
> it against your real data before spending anything:
> ```
> → audiences_draft_rule { description:"ready for Enterprise: usage limits, SSO/security, scale" }
> ← select:{ about:"SSO, security, scale, seat limits",
>            judge:{ criteria:"genuinely evaluating an Enterprise upgrade", confidence:0.7 } }
> → audiences_preview_rule { rule:<draft>, sample:50 }
> ← candidate_pool:1830  est_matches:~240  full_scan:false  confirm_required:false
>   sample_reasons:[ "Read /enterprise once — weak",
>                    "Hit the 5-seat limit twice + read the SSO doc",
>                    "On the Apr 28 call asked 'do you support SAML?'; viewed audit-log" ]
> ```
> `candidate_pool` is the survivor count *after* `about` + `filter` — exactly the number the judge
> runs on. ~240 would match, but the sample's loose — some just browsed. Want me to add a hard
> `filter` gate: a real scale signal **and** a security-doc visit?

> **You:** Yes, tighten it.

> **Claude:**
> ```
> → audiences_preview_rule { rule:<tighter>, sample:50 }
> ← candidate_pool:640  est_matches:~120  est_cost:"$0.30"
>   sample_reasons:[ "Hit the seat limit, then read SSO + SCIM docs across two sessions",
>                    "Call asked about SAML + SLA; viewed audit-log + role-permissions" ]
> ```
> Tighter — ~120, every reason has a real scale signal + security interest, across web + voip.
> Ship it?

> **You:** Ship it.

> **Claude:**
> ```
> → audiences_create_rule  { rule:<tighter, id:"enterprise_ready"> }
> → audiences_evaluate     { rule_id:"enterprise_ready", dryRun:true }
> ← evaluated:640 matched:118 after_consent:95 would_fire:{meta:95,tiktok:95} est_cost:"$0.30"
> ```
> Dry run: 118 qualify, 95 are marketing-consented → 95 events to each network. Fire for real?

> **You:** Go.

> **Claude:**
> ```
> → audiences_evaluate { rule_id:"enterprise_ready", dryRun:false }
> ← matched:118 fired:{meta:95,tiktok:95} suppressed:23 cost:"$0.30"
> ```
> Done — fired for 95 on each network. **One-time on the platform:** create a Custom Audience with the
> rule *"triggered `wb_enterprise_ready` in the last 30 days"* and point your Enterprise creative at
> it. I'll **re-fire weekly** for anyone who still qualifies so they don't age out; if they stop
> qualifying I stop firing and the platform ages them out. WhiteBox doesn't size the audience — Meta/
> TikTok own that.

### 2 · "What do you even know about my users?" (discovery)

> **You:** Before I write rules — what CRM signals do you actually have on people?

> **Claude:**
> ```
> → audiences_list_facts {}
> ← [ {key:"plan_tier", type:"string", sample:"pro", last_seen:"2026-06-17"},
>     {key:"seat_count", type:"number", sample:5},
>     {key:"mrr", type:"number", sample:240},
>     {key:"trial_ends_at", type:"date", sample:"2026-06-25"} ]
> ```
> You've got `plan_tier`, `seat_count`, `mrr`, and `trial_ends_at` flowing in. So rules can gate on
> plan/seats/MRR/trial-window — plus anything topical from the content people read or said. What do
> you want to build?

### 3 · A rule that gates on a fact you're not sending

> **You:** Build an audience of people whose **contract is up for renewal in 30 days** and who've been
> reading competitor-comparison content.

> **Claude:** Let me check what facts exist before I add that gate:
> ```
> → audiences_list_facts {}
> ← [ {key:"plan_tier"}, {key:"seat_count"}, {key:"mrr"}, {key:"trial_ends_at"} ]
> → audiences_preview_rule { rule:{ select:{
>     about:"competitor comparison, alternatives",
>     filter:{ fact:{ renewal_date:{ next:"30d" } } } } }, sample:50 }
> ← candidate_pool:0  est_matches:~0
> ```
> Heads up — the competitor-reading part is fine on its own, but there's **no `renewal_date` fact**
> in the base (only `plan_tier`, `seat_count`, `mrr`, `trial_ends_at`), so the `filter` gates everyone
> out and `candidate_pool` collapses to 0. Two options: push `renewal_date` to `/crm/facts` from your
> CRM so it becomes a core fact, or I drop that clause and target the competitor-reading `about` alone.
> Which?

### 4 · Explain why someone's in an audience (audit / compliance)

> **You:** Legal wants to know why passport `a17f…` is in `enterprise_ready`.

> **Claude:**
> ```
> → audiences_explain_match { rule_id:"enterprise_ready", passport_id:"a17f…" }
> ← score:0.88  qualified:true
>   reason:"Hit the 5-seat limit twice; read SSO + SCIM docs across two sessions; on the Apr 28 call asked 'do you support SAML?'."
>   evidence:[ {channel:"web",content_id:"sso-setup",dwell_ms:52000},
>              {channel:"web",content_id:"seat-limit",action:"hit"},
>              {channel:"voip",snippet:"...do you support SAML..."} ]
>   fired:{meta:"2026-06-17",tiktok:"2026-06-17"}  consent:"marketing:granted"
> ```
> Every membership carries this. They qualified on a seat-limit event + SSO/SCIM reading + a SAML
> question on a call, they're marketing-consented, and we fired on Jun 17. That's the full trail.

### 5 · Take someone out (suppression / opt-out)

> **You:** This person emailed us to stop being targeted — passport `c0de…`.

> **Claude:**
> ```
> → audiences_suppress { passport_id:"c0de…", reason:"user opt-out 2026-06-17" }
> ← { ok:true }
> ```
> Done. They're on the do-not-target list now — they'll never be evaluated or fired for **any** rule,
> regardless of consent, and we'll stop re-firing so the platforms age them out of every audience.

### 6 · Why is Google missing? (network readiness)

> **You:** Why did you skip Google earlier?

> **Claude:**
> ```
> → audiences_network_status {}
> ← google:{ event, transport:"ga4", eligible:false, reason:"GA4 stream not configured" }
> ```
> Google goes through **GA4 Measurement Protocol** here — fire an event into a GA4 stream, build the
> audience in GA4, link it to Google Ads/DV360. It's not eligible because `WB_GA4_MEASUREMENT_ID` /
> `WB_GA4_API_SECRET` aren't set, and the client needs to capture the `_ga` `client_id`. Set those and
> Google joins the same flow as Meta/TikTok. See `docs/networks/google-ga4.md`.

### 7 · A different shape: win-back (a pure-negative filter)

> **You:** Customers who were active and engaged but have **gone quiet for 3+ weeks** and previously
> looked at our higher tier — I want a win-back audience on Meta.

> **Claude:**
> ```
> → audiences_preview_rule { rule:{
>     select:{
>       about:"premium plan, upgrade, advanced features",
>       filter:{ not:{ metric:{ content:"*", recency_days:{ lte:21 } } } },
>       judge:{ criteria:"previously showed upgrade interest but has gone inactive", confidence:0.7 } },
>     delivery:{ meta:{ event:"wb_winback" } } }, sample:50 }
> ← candidate_pool:520  est_matches:~140  full_scan:true
>   sample_reasons:[ "Viewed the Premium page 2× in April, nothing since (28 days quiet)",
>                    "Started an upgrade flow, dropped off; last seen 24 days ago" ]
> ```
> ~140 dormant upgrade-interested accounts. The `not recency_days ≤ 21` is a hard `filter` gate (real
> SQL, not a guess), and the upgrade-interest part is `about` + the `judge`. Note `full_scan:true` —
> a pure-negative filter has nothing to seek on, so the engine walks the whole base; it's flagged here
> so it's never a silent surprise. Commit it?

---

## Or drive it over REST

Everything the MCP tools do is also REST, behind the management bearer secret:

```bash
TOKEN=$WB_AUDIENCES_TOKEN

# preview before committing
curl -s -X POST localhost:3000/audiences/rules/enterprise_ready/preview \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"sample":50}'

# evaluate (dry run by default)
curl -s -X POST localhost:3000/audiences/rules/enterprise_ready/evaluate \
  -H "authorization: Bearer $TOKEN" -d '{"dryRun":false}'

# explain a match
curl -s localhost:3000/audiences/rules/enterprise_ready/members \
  -H "authorization: Bearer $TOKEN"
```

Full reference: [docs/09-api.md](docs/09-api.md).

## Mode A vs Mode B (so you're never surprised)

| | **Mode A** (v1, this plugin) | **Mode B** (v2) |
|---|---|---|
| how it segments | fire a custom event → platform builds the audience from a rule on it | upload/remove members directly |
| who owns membership | the **platform** (recency window) | **WhiteBox** (explicit add/remove) |
| removal / decay | window only (stop firing → ages out) | precise |
| small segments | platform pools over the window | blocked by min-size |
| config cost | one-time audience rule per segment | audience CRUD + buffer-until-min |
| WhiteBox knows | who matched · why · what it fired | the full roster + size |

## Documentation

Everything needed to make it work end-to-end lives in [`docs/`](docs/):

| | |
|---|---|
| [01 · Architecture](docs/01-architecture.md) | components, data flow, data model |
| [02 · Concepts](docs/02-concepts.md) | Mode A vs B, matches ≠ membership, selector vs funnel sources |
| [03 · Rules](docs/03-rules.md) | rule schema (`select` / `funnel` slot), authoring, lifecycle |
| [04 · Evaluator](docs/04-evaluator.md) | the thin adapter over `ctx.selector`, cohort resolve, cost, keep-warm |
| [05 · Networks](docs/05-networks.md) + [meta](docs/networks/meta.md) · [tiktok](docs/networks/tiktok.md) · [ga4](docs/networks/google-ga4.md) | adapter contract + per-network setup |
| [06 · Identity](docs/06-identity.md) | the manifest, the client capture shim, hashing, match keys |
| [07 · CRM integration](docs/07-crm-integration.md) | the generic facts webhook, integrating with **any/unknown** CRM, discovery |
| [08 · Consent & privacy](docs/08-consent-privacy.md) | consent gating, hashing, sensitive-category guard, GDPR audit |
| [09 · API](docs/09-api.md) | REST + MCP reference, auth |
| [10 · Deployment](docs/10-deployment.md) | config, env, queue, scheduling, migrations |

## Status

**v0.1 scaffold.** Mode A only; selection runs on the core selector engine (the `judge`'s similarity
floor + confidence still want a tune-by-feel pass), and the network HTTP calls are wired but need your
credentials. No rule versioning, no Mode B yet. See each adapter doc for the exact API surface it calls.
