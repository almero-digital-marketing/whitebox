# WhiteBox Connect — architecture plan

> **Status:** design / not started. We pick this up **after** WhiteBox Pro is
> integrated and running in real projects (the self-hosted core + the measurement
> loop come first; the broker is the monetization layer on top).
>
> **Naming:** "WhiteBox Connect" (hosted at **whitebox.pro**) is a working name
> for the brokered-integration service. `server-plugin-insights`, `insights()`,
> `connect()` below are provisional.
>
> **Where this lives:** kept out of the `whitebox-pro/` monorepo on purpose — that
> tree is designed to be shareable/public (see `docs/08-integrations.md`), and
> this doc carries the commercial/pricing model. Move it into the repo as an RFC
> if/when that's wanted.

---

## 1. Why this exists — the wedge

Self-hosted WhiteBox instances need **ad-platform reporting data** (Meta / Google /
TikTok campaign spend, impressions, clicks) to close the view → act → **measure**
loop with ROAS. The blocker isn't code — reporting APIs are well-documented — it's
that **every customer getting their own platform approval is prohibitive**:

- Meta App Review for `ads_read`
- Google Ads **standard-access developer token** (review + an MCC)
- TikTok Marketing **partner** status

These approvals take weeks–months each and carry ongoing compliance. **WhiteBox
Connect pays them once, centrally, and brokers each customer's own ad accounts
into the approved apps via OAuth.** The customer clicks "connect account" — no
review on their side.

**The insight:** the approvals we'd otherwise want to *skip* become the thing we
*sell*. This is exactly Windsor/Supermetrics/Fivetran's real moat (commodity
connectors; the moat is holding the approved apps and amortizing them across all
customers). Open-core: give away the engine, charge for the piece with a genuine
approval/network moat that's painful to self-host.

**Why our version beats a generic aggregator** — see §2. We never centralize the
customer's first-party data, only their (aggregate, non-PII) ad reports.

---

## 2. First principle — the PII boundary (asymmetric data flow)

This is the whole differentiator and every component decision derives from it.

```
            ┌──────────────────────────────────────────┐
   UP  ───► │  WhiteBox Connect (whitebox.pro)          │
 (consent   │  • holds the approved platform apps       │
  only,     │  • holds the customer's OAuth token(s)    │
  no PII)   │  • pulls aggregate ad reports             │
            └──────────────────────────────────────────┘
   DOWN ◄───  aggregate, campaign-level metrics only
            (spend / impressions / clicks / UTM — NO platform user rows)

   ┌───────────────────────────────────────────────────┐
   │  Self-hosted WhiteBox instance (customer's infra)  │
   │  • passports, identities, events    ← NEVER leaves │
   │  • ad_insights (received from Connect)             │
   │  • the ROAS join happens HERE                      │
   └───────────────────────────────────────────────────┘
```

- **UP (instance/customer → Connect):** OAuth consent + which ad accounts to sync.
  **No customer PII, ever.** There is deliberately no ingest path for first-party
  data into Connect.
- **DOWN (Connect → instance):** normalized, aggregate ad metrics. **No platform
  user-level rows** (the reporting APIs are aggregate anyway).
- **First-party PII** (passports, identities, events, masked contacts) **never
  leaves the self-hosted instance.** The ROAS join — spend against attributed
  revenue — runs *inside* the instance.

The marketing line a generic aggregator structurally cannot say: *"your customer
data never touches our servers — only your ad reports come down."*

**Honest caveat to keep in our own copy:** Connect *does* become custodian of the
customer's **ad-account OAuth tokens** (read access to ad spend). We don't touch
their CDP PII, but we can read their ad accounts. State that boundary precisely so
the privacy claim stays truthful (§8).

---

## 3. How it fits today's architecture

WhiteBox already has a clean **channel / provider** split (`docs/08-integrations.md`):

- a **channel** owns plumbing (queue, retries, schema, awareness, webhook routing);
- a **provider** owns outside-world specifics (transport, auth, payload shapes);
- providers live in **their own `whitebox-pro-*` repos** under the gitignored
  `whitebox-pro-integrations/`, symlinked in via `link-integrations.sh`; a provider
  is **`eligible` only when its credentials are present**.

The ad-network adapters **already exist** for the **outbound** leg —
`whitebox-pro-adnetworks-{meta,google,tiktok}` do server CAPI/MP/Events **push**
(`server-plugin-conversions`). Connect is the **inbound (pull)** counterpart:

| leg | direction | plugin | creds today | Connect's role |
|---|---|---|---|---|
| conversions / CAPI | **push** events → platforms | `server-plugin-conversions` (exists) | customer-supplied | could later broker these creds too (§10 Phase 3) |
| **insights / reporting** | **pull** reports ← platforms | `server-plugin-insights` (**new**) | brokered by Connect | the managed place to run the pull adapters, holding the approved apps |

So Connect is conceptually small: **"a hosted, multi-tenant place to run the pull
adapters, that carries the approved platform apps."** The moat is the apps it
carries, not the adapter code.

---

## 4. Components

### 4.1 Connect Gateway (whitebox.pro) — hosted, multi-tenant

The only new *service*. Responsibilities:

- **Approved apps vault.** Holds the Meta app (`ads_read`), the Google Ads MCC +
  standard-access developer token, the TikTok marketing-partner app. (These are
  the moat; obtaining them is the long-lead dependency — start early, §11.)
- **OAuth broker.** Runs each platform's consent flow for a customer's ad
  account(s); stores per-account refresh tokens **encrypted at rest**, scoped to
  read-only reporting. Revocable per account.
- **Metered relay.** Per request, inject `Connect app creds + the brokered token`,
  forward to the platform's reporting API, **stream the response back (not stored)**,
  and meter the call. The instance **pulls on its own schedule**; **normalization
  happens at the edge** (the instance's adapter), so Connect stays thin and holds no
  ad data. (This thin-relay model replaces an earlier "sync worker + push-down"
  sketch — see whitebox-connect-gateway.md, the governing detail.)
- **Tenant registry + metering.** Customer registers an instance (instance URL +
  per-instance key / mTLS), connects accounts, sees relay/sync status; usage metered
  for billing (§9).

Tenancy isolation is strict: a tenant's relay can only ever read that tenant's
brokered tokens and serve that tenant's registered instance.

### 4.2 Self-hosted — `server-plugin-insights` (the ad-insights channel)

Mirrors the existing channel/provider pattern. The **channel** owns:

- the `whitebox_ad_insights` schema + idempotent upsert (§4.4);
- the **sync loop**: on its own schedule it pulls each source (the `connect()`
  source goes through the relay; see -relay-client.md), normalizes at the edge, and
  upserts locally — plus a **`POST /insights/import`** endpoint for the manual
  `csv()` path. No inbound push from Connect; data only ever flows *down* via the
  pull, and no PII ever flows up;
- exposure of the data to **Analytics** so compose/ROAS queries can read paid-media
  spend joined to first-party conversions by UTM (§6);
- awareness/health (last sync per source/account).

Composed like the other channels:

```js
// whitebox.config.js
insights({ source: connect({ instanceKey: env.WB_CONNECT_KEY }) })   // managed (paid)
insights({ source: csv() })                                          // manual import (free)
insights({ source: meta({ devToken, … }) })                          // BYO approvals (self-host)
```

`source` is provider-agnostic and follows the **`eligible`-when-creds-present**
rule, so an unconfigured source simply doesn't run.

### 4.3 Pull provider adapters — `whitebox-pro-insights-{meta,google,tiktok}`

External `whitebox-pro-*` repos (same convention as the existing adnetworks). Each
owns one platform's reporting specifics: report request shapes, pagination, field
mapping → canonical, UTM/naming parsing. **Key property: the same adapter runs in
two contexts**, differing only in *where it runs* and *whose app creds it uses*:

- **inside Connect** — Connect's approved app creds + the customer's brokered token
  → the **managed** path (no customer approval);
- **inside a self-hosted instance** — the customer's *own* app creds → the
  **BYO-approval** path (for sophisticated customers who already hold approvals
  and want zero third-party in the loop).

That symmetry is what keeps Connect honest as "just the managed runner": the moat
is the apps, not the code.

### 4.4 Canonical `ad_insights` schema — the join target (build this FIRST)

Source-agnostic, so CSV / Connect / BYO all land in the same table and the
downstream ROAS query is identical. Sketch (knex, `whitebox_` prefix, jsonb — match
`server-plugin-conversions` conventions):

```
whitebox_ad_insights
  id            uuid pk
  source        text         -- 'meta' | 'google' | 'tiktok' | 'csv'
  account_id    text
  level         text         -- 'campaign' | 'adset' | 'ad'
  entity_id     text         -- platform id at that level
  entity_name   text
  date          date         -- daily grain (platform-local; tz noted per source)
  currency      text
  spend         numeric
  impressions   bigint
  clicks        bigint
  conversions   numeric null -- platform-reported (kept separate from first-party)
  revenue       numeric null -- platform-reported (kept separate)
  utm           jsonb        -- { source, medium, campaign, content, term } parsed
                             --   from naming / tracking template
  raw           jsonb        -- the source row, for re-derivation
  synced_at     timestamptz
  -- idempotent upsert:
  UNIQUE (source, account_id, level, entity_id, date)
  INDEX (utm->>'campaign', date)   -- the ROAS join key
```

Platform-reported `conversions`/`revenue` are stored **separately** from
first-party conversion revenue and never silently reconciled (attribution windows
differ — §11).

---

## 5. Data flow (end to end)

```
1. Customer (in WhiteBox UI or whitebox.pro portal) → "Connect Meta account"
2. OAuth consent runs against Connect's APPROVED Meta app  → Connect stores an
   encrypted, read-only token for that ad account. (no PII up)
3. Instance's insights channel, on ITS OWN schedule, pulls through the relay:
      relay(meta, insights.query) → Connect injects app creds + the brokered token,
        forwards to Meta, streams the report back (NOT stored), meters the call.
   (thin-relay model — instance-initiated; see whitebox-connect-gateway.md, which
    refines the earlier "sync worker + push-down" framing.)
4. The instance's adapter normalizes → upserts into whitebox_ad_insights (dedup on UNIQUE).
5. Analytics compose / ROAS query (inside the instance):
      join ad_insights.spend  ⨝  first-party conversions.revenue  ON utm_campaign+date
        → spend / revenue / ROAS per campaign — no user-level data ever left.
6. Connect meters each relay call for billing.
```

---

## 6. The measurement payoff — UTM → conversion ROAS

First-party events already capture UTMs on the passport/session. The join the whole
service exists to enable:

- **Paid side (`ad_insights`):** spend / impressions / clicks per `utm.campaign` per day.
- **Earned side (first-party):** **conversions**/revenue attributed to the same
  `utm_campaign` within the attribution window — resolved through the existing
  selector engine, **inside the instance**, against real (masked) passport data. The
  conversion is whatever revenue event the customer tracks (purchase, signup, lead,
  order, …) — a configurable event, not a fixed entity.
- **Result:** `ROAS = first_party_revenue / ad_spend` per campaign — surfaced as an
  Analytics report / a Campaigns "Build report" objective.

This join is **identical regardless of how `ad_insights` was populated** (CSV,
Connect, or BYO), which is why the table is the right first brick.

---

## 7. Source-agnostic ingest — three sources, one channel

| source | who runs the pull | approvals | cost | for |
|---|---|---|---|---|
| **`csv()`** | nobody (manual export → import) | none | **free** | day-one, demos, low cadence, the design-partner client |
| **`connect()`** | WhiteBox Connect (managed) | **none on the customer** | paid (metered) | most customers — automation + zero approvals |
| **`meta()/google()/tiktok()`** (BYO) | the instance itself | customer's own | free (self-host) | sophisticated customers who already hold approvals |

Same `whitebox_ad_insights`, same ROAS query downstream. The free CSV path is
**always available** so the paid tier is a convenience upgrade, not a hostage
situation.

---

## 8. Security & platform compliance (the honest costs)

Not free money — a standing commitment. Budget for it explicitly.

- **Token custody.** Connect holds customer ad-account OAuth tokens (read-only
  reporting scope). Encryption at rest, per-tenant isolation, rotation, per-account
  revocation. This is the one place the "PII never leaves" claim needs the precise
  asterisk: *ad-account access* is held, *CDP PII* is not.
- **Instance ↔ Connect auth.** Per-instance key or mTLS; Connect only ever pushes a
  tenant's **own** data to that tenant's registered endpoint; payloads signed.
- **Platform partner obligations (ongoing).** Meta Tech Provider / Business Partner
  tier; Google Ads token-holder RMF compliance + MCC; TikTok partner program. Each
  is periodic re-review + API-version churn — i.e. the connector-maintenance
  treadmill that is literally an aggregator's whole business. **Scope tight:** the
  three ad platforms first, not "all integrations."
- **Architectural PII enforcement.** No endpoint on Connect accepts first-party
  data; data flow is one-directional (down). Make this a tested invariant, not a
  policy.

---

## 9. Packaging & pricing

Meter the thing with the moat; keep the free tier genuinely useful.

- **Free, self-hosted, forever:** core engine + `csv()` import + `BYO` direct
  providers. Always works, no approval, no bill.
- **Paid (Connect):** per **connected ad account / source / month**, metered
  (Windsor's axis). Value line = *automation + zero platform approvals*, not data
  you couldn't otherwise get.

The customer sophisticated enough to BYO approvals will skip Connect — fine, they
were never the buyer. The buyer is the agency / SMB / the design-partner customer
who values never touching Meta App Review.

---

## 10. Phasing / roadmap

- **Phase 0 — now, before Connect exists (free, no external deps):**
  `server-plugin-insights` channel + `whitebox_ad_insights` schema + **`csv()`
  source** + the **UTM→conversion ROAS join** surfaced in Analytics. Validates the
  *measurement* loop end-to-end with zero platform risk; demoable to the
  design-partner customer immediately. **This is the first brick.**
- **Phase 1 — Connect MVP, one platform:** stand up the whitebox.pro gateway with
  the lowest-friction / highest-value platform first; OAuth broker + metered relay;
  the instance-side `connect()` source; basic metering.
- **Phase 2 — breadth + ops:** add the other two platforms; incremental backfill +
  reconciliation; billing portal; relay caching.
- **Phase 3 — broker the outbound leg too (optional):** route CAPI / mail / SMS
  provider creds through Connect as well, so customers don't need their own provider
  apps for *delivery* either. Connect becomes the universal approved-app broker for
  both push and pull.

---

## 11. Risks & open questions

- **Approval lead time is the gating dependency.** Connect's own Meta/Google/TikTok
  partner apps take weeks–months. **Start the partner applications early** —
  parallel to Phase 0, well before Phase 1 code.
- **Google access model:** MCC + account-link vs per-account OAuth — decide before
  Phase 1.
- **Delivery model (resolved):** instance-initiated **relay** (the instance pulls on
  its own schedule), not Connect-side push-down — so no inbound reach to the instance
  and no firewall problem. See whitebox-connect-gateway.md / -relay-client.md.
- **Token residence:** Connect-held-encrypted (simplest, MVP) vs customer-held +
  Connect-relayed (better privacy, more moving parts). Lean Connect-held for MVP.
- **Normalization:** multi-currency, timezone, and platform attribution-window
  mismatches. Keep platform-reported conversions/revenue in their own columns;
  never silently reconcile with first-party conversions.
- **Cannibalization check:** keep `csv()` free and good enough that it's a real
  fallback, so Connect sells on convenience, not lock-in.

---

## 12. Out of scope (deferred)

- Billing/payments implementation details.
- The actual platform partner-application *process* (this is the architecture, not
  the paperwork).
- Phase 3 outbound brokering (sketched only).
- Onboarding the specific design-partner customer.
</content>
</invoke>
