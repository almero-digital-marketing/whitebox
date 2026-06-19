<div align="center">

# whitebox-pro-server-plugin-audiences

**Build ad-network audiences by reasoning over what WhiteBox knows about each person.**

Describe a segment in plain language → the plugin reasons over each passport's cross-channel
awareness (web, email, voip, CRM) against your rule → it reports a custom event to **Meta, TikTok
and Google (GA4)**, and the platforms build the audience.

</div>

---

## Why this exists

A pixel sees one channel and one session. WhiteBox sees the **whole person** — every paragraph they
read, every call they had, every email they opened, plus CRM state — as one queryable memory. This
plugin turns that memory into **ad audiences you can explain**, instead of ones a network guesses at.

You target on **understanding**, and every person in an audience has a human-readable *"why."*

## How it works (Mode A)

```
 awareness (web · email · voip · crm)
        │  declarative rule (you write it, or draft it by talking)
        ▼
   evaluator:  vector-narrow → AI-confirm   (semantic · metric · crm features)
        │  a qualified match, with a reason
        ▼
   fire custom event  ──▶ { Meta CAPI · TikTok Events API · GA4 Measurement Protocol }
        │
        ▼
   the platform builds + ages the audience from a rule on your event
```

**This is Mode A.** WhiteBox fires events and keeps them warm; **the platform owns the audience, its
size, and its decay.** WhiteBox knows *who matched, why, and what it fired* — not a membership roster.
(Direct membership upload — Mode B — is a v2 upgrade. See [docs/02-concepts.md](docs/02-concepts.md).)

## Three kinds of evidence

A rule blends three feature families, and the evaluator assembles whichever it needs:

| family | question | source |
|---|---|---|
| **semantic** | *what did they engage with?* (intent, topic, concern) | awareness embeddings — vector recall |
| **metric** | *how often / how recent / how long?* | SQL aggregates over exposures |
| **crm** | *who are they / what state?* (plan, usage, MRR) | generic CRM facts via the context registry |

The LLM judges *meaning*; it never counts (metric does) or invents state (crm does). Details:
[docs/04-evaluator.md](docs/04-evaluator.md).

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
> Meta + TikTok ready; Google's GA4 isn't wired, so I'll skip it. Drafting a rule and previewing it
> against your real data before spending anything:
> ```
> → audiences_draft_rule { description:"ready for Enterprise: usage limits, SSO/security, scale" }
> → audiences_preview_rule { rule:<draft>, sample:50 }
> ← candidate_pool:1830  est_matches:~240  est_cost:"$0.47"
>   requires:{ crm:"ok", warnings:[] }
>   sample_reasons:[ "Read /enterprise once — weak",
>                    "Hit the 5-seat limit twice + read the SSO doc",
>                    "On the Apr 28 call asked 'do you support SAML?'; viewed audit-log" ]
> ```
> ~240 would match, but the sample's loose — some just browsed. Want me to require a real scale
> signal **and** a security interest?

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

### 3 · A rule that needs a fact you're not sending (the `requires` guard)

> **You:** Build an audience of people whose **contract is up for renewal in 30 days** and who've been
> reading competitor-comparison content.

> **Claude:**
> ```
> → audiences_preview_rule { rule:{ requires:{ crm:["renewal_date"], semantic:["competitor comparison"] } }, sample:50 }
> ← candidate_pool:410  est_matches:~0
>   requires:{ crm:"missing", warnings:["No CRM facts seen for: renewal_date — rule will under-match until ingested."] }
> ```
> Heads up — the competitor-reading part is fine (410 candidates), but **you're not sending a
> `renewal_date` fact**, so this rule would match almost nobody. Two options: push `renewal_date` to
> `/crm/facts` from your CRM, or I drop that requirement and target on the competitor-reading signal
> alone. Which?

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

### 7 · A different shape: win-back

> **You:** Customers who were active and engaged but have **gone quiet for 3+ weeks** and previously
> looked at our higher tier — I want a win-back audience on Meta.

> **Claude:**
> ```
> → audiences_preview_rule { rule:{
>     seed:"premium plan, upgrade, advanced features",
>     criteria:"Previously showed upgrade interest but has gone inactive",
>     requires:{ semantic:["upgrade interest"], metric:[{content:"*",metric:"recency_days",gte:21}] },
>     delivery:{ meta:{ event:"wb_winback" } } }, sample:50 }
> ← candidate_pool:520  est_matches:~140  est_cost:"$0.31"
>   sample_reasons:[ "Viewed the Premium page 2× in April, nothing since (28 days quiet)",
>                    "Started an upgrade flow, dropped off; last seen 24 days ago" ]
> ```
> ~140 dormant upgrade-interested accounts. The `recency_days ≥ 21` is a hard metric gate (real SQL,
> not a guess), and the upgrade-interest part is semantic. Commit it?

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
| [02 · Concepts](docs/02-concepts.md) | Mode A vs B, matches ≠ membership, the three families |
| [03 · Rules](docs/03-rules.md) | rule schema, `requires`, authoring, lifecycle |
| [04 · Evaluator](docs/04-evaluator.md) | vector-narrow → AI-confirm, feature assembly, cost, determinism |
| [05 · Networks](docs/05-networks.md) + [meta](docs/networks/meta.md) · [tiktok](docs/networks/tiktok.md) · [ga4](docs/networks/google-ga4.md) | adapter contract + per-network setup |
| [06 · Identity](docs/06-identity.md) | the manifest, the client capture shim, hashing, match keys |
| [07 · CRM integration](docs/07-crm-integration.md) | the generic facts webhook, integrating with **any/unknown** CRM, discovery |
| [08 · Consent & privacy](docs/08-consent-privacy.md) | consent gating, hashing, sensitive-category guard, GDPR audit |
| [09 · API](docs/09-api.md) | REST + MCP reference, auth |
| [10 · Deployment](docs/10-deployment.md) | config, env, queue, scheduling, migrations |

## Status

**v0.1 scaffold.** Mode A only; the evaluator's LLM judge and the network HTTP calls are wired but
need your credentials + a tune-by-feel pass. No rule versioning, no Mode B yet. See each adapter doc
for the exact API surface it calls.
