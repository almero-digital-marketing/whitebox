# whitebox.pro — thin OAuth broker + metered gateway

> **Companion to** [`whitebox-connect.md`](whitebox-connect.md). That doc is the
> whole monetization layer; this one is the detailed architecture of the **hosted
> service itself** (§4.1 there). The **instance-side** transport that calls this
> gateway's relay is specified in
> [`whitebox-connect-relay-client.md`](whitebox-connect-relay-client.md).
>
> **Status:** design / not started. **Naming** provisional.
>
> **Refinement of the parent plan:** the parent sketched Connect-side *sync workers*
> + *push-down* to the instance. This doc adopts the **thin metered-relay** model
> instead: the **instance pulls** through a credentialed proxy on its own schedule.
> That removes the gateway's scheduler **and** the push-down path **and** the
> firewalled-instance problem (it's always instance-initiated, so the gateway never
> needs inbound reach to the instance). Where the two docs differ, **this one wins
> for the gateway.**

---

## 1. What "thin" means here

The gateway holds **credentials and counters, not data.** Everything else is pushed
to the edges:

| concern | lives in the gateway? | where instead |
|---|---|---|
| approved platform apps (client_id/secret, Google dev token) | **yes** — the moat | — |
| customer ad-account OAuth tokens (encrypted) | **yes** | — |
| usage / metering counters | **yes** | — |
| tenant / instance / account registry + entitlements | **yes** | — |
| **ad-insight rows** | **no** (transit only, never persisted) | self-hosted `whitebox_ad_insights` |
| report semantics / field maps / normalization | **no** | edge pkgs `whitebox-pro-insights-*` |
| sync **schedule / cadence** | **no** | the instance |
| billing / invoicing | **no** | Stripe (gateway only emits usage) |
| the ROAS join, customer PII | **no** | the instance |

So the gateway is: **a multi-tenant credential vault + a stateless, metered,
per-platform reverse proxy + a usage meter.** One service, one small DB, a KMS, a
billing provider. That's the whole thing.

---

## 2. The model decision — metered relay, not token-vending

Three ways to put the approved app between the instance and the platform:

- **A · Metered relay (CHOSEN).** Instance calls the gateway; the gateway injects
  app creds + the account's access token, forwards to the platform, **streams the
  response back without persisting it**, and records one usage event. The gateway
  stays in the path → metering is exact and the platform app token is **never
  handed to the instance**.
- **B · Connect-side sync worker.** Gateway schedules jobs, pulls, normalizes,
  pushes down. Rejected: not thin (scheduler + normalization + staging + inbound
  reach to the instance), and it's the heavier framing from the parent.
- **C · Token vending.** Gateway mints a short-lived token and hands it to the
  instance, which calls the platform **directly** (gateway never sees the data, not
  even in transit). Best privacy, but **breaks metering** (you can't count calls you
  don't see → only coarse issuance-based metering) and **leaks the app-scoped token**
  to the instance (ToS + abuse risk). Documented as a fallback if a customer demands
  "the gateway never sees our data in transit," accepting coarse metering.

**A is the default.** Metering requires being in the path; you must not surrender the
app's platform token. The honest cost of A: report bodies **transit** the gateway's
memory (not persisted). State that precisely (§7).

---

## 3. Subsystems

```
                         whitebox.pro
   ┌───────────────────────────────────────────────────────────────┐
   │  control plane (portal API)        data plane (relay)          │
   │  ┌───────────────────────┐        ┌────────────────────────┐   │
   │  │ tenant/instance/       │        │ /v1/relay/{platform}/  │   │
   │  │ account registry       │        │   {operation}          │   │
   │  │ entitlements / plan     │       │  authz → quota →       │   │
   │  │ OAuth connect + callback│       │  inject creds → fwd →  │   │
   │  └───────────────────────┘        │  stream back → meter   │   │
   │  ┌───────────────────────┐        └────────────────────────┘   │
   │  │ OAuth broker          │   ┌──────────────┐  ┌────────────┐  │
   │  │ • app vault (KMS)     │   │ token service │  │ meter store │  │
   │  │ • per-platform refresh│   │ refresh→access│  │ append-only │  │
   │  └───────────────────────┘   └──────────────┘  └────────────┘  │
   └───────────────────────────────────────────────────────────────┘
        ▲ portal calls (connect account, usage)       │ usage rollup
        │ (from the WhiteBox UI or a portal)           ▼
   self-hosted instance ── data-plane relay calls ──►  Stripe (metered billing)
```

**3.1 Tenant & instance registry.** Tenant (org) → instances (one per deployment;
each with an `instance_id` + a long-lived **instance key** or **mTLS client cert**)
→ connected ad accounts (per platform). Plan/entitlements per tenant (which
platforms, quotas).

**3.2 OAuth broker.**
- *App vault:* the approved apps' secrets (Meta app, Google MCC + developer token,
  TikTok app), in a KMS/secret manager — never in app config.
- *Connect flow:* portal starts a per-account OAuth; the callback exchanges code →
  **refresh token**, stored with **envelope encryption** (KMS data key), keyed by
  `(tenant, platform, account)`, scoped **read-only reporting**.
- *Per-platform refresh logic* (small modules, mirror the edge adapters):
  - **Meta:** long-lived user/system-user token; account = `act_<ad_account_id>`.
  - **Google Ads:** developer token in a header (app-level) **+** per-user OAuth
    refresh token; accounts reached via the MCC / account links → `customer_id`.
  - **TikTok:** `access_token` + `advertiser_id`.
- *Revocation:* per account (disconnect) and tenant-wide (offboarding → delete tokens).

**3.3 Metered gateway (the relay).** One narrow data-plane endpoint per operation
(`insights.query`, `accounts.list`, `token.introspect`). Per request:
1. **authn** the instance (key / mTLS);
2. **authz** — tenant owns the requested account? entitled to the platform?
3. **quota** — within the tenant's rate budget? (see §6, the blast-radius problem);
4. **token** — token service returns a cached/refreshed access token;
5. **forward** to the platform with app creds + token; **stream** the response back;
6. **meter** — emit one usage event `{tenant, platform, account, operation, units, rows?, bytes, ts}`.
Optional thin **short-TTL cache** of identical report requests to cut platform
calls/cost — skippable to stay thin.

**3.4 Metering & billing pipeline.** Usage events → append-only meter store →
period rollups per tenant → **Stripe** (usage-based). Invoicing is **not** in the
gateway.

**3.5 Control plane / portal.** Register tenant, connect accounts (OAuth), mint
instance keys, view usage + connection health. Minimal — ideally **driven from the
WhiteBox self-hosted UI** via a portal API, so the customer connects accounts from
inside their own product ("connect-from-the-product"), not a separate console.

---

## 4. Request lifecycle (the hot path)

```
instance: whitebox-pro-insights-meta adapter
  POST https://whitebox.pro/v1/relay/meta/insights.query
     auth: instance key (mTLS)
     body: { account_id, level:'campaign', date_range, fields:[spend,impressions,clicks,…] }

whitebox.pro:
  authn instance ─► authz (tenant owns account? entitled to meta? under quota?)
  ─► token service: refresh(tenant,meta,account) → access token (cached)
  ─► forward to Meta Insights API  (Connect app creds + access token)
  ─► stream response back to instance        ← NOT persisted
  ─► meter: usage event { tenant, meta, account, rows, units, ts }

instance:
  normalize → upsert whitebox_ad_insights → UTM⨝conversion ROAS   (all local, PII stays home)
```

The instance's **own scheduler** decides how often to call. The gateway is stateless
per request.

---

## 5. API surface (v1)

**Control plane** (portal/admin auth; called by the WhiteBox UI or a portal):
- `POST /v1/tenants`, `POST /v1/instances` → `{ instance_id, instance_key }`
- `GET /v1/connect/{platform}/start` → OAuth URL · `GET /v1/connect/{platform}/callback`
- `GET /v1/accounts` · `DELETE /v1/accounts/{id}` (disconnect)
- `GET /v1/usage?period=…` (also powers in-product usage display)

**Data plane** (instance-key / mTLS auth; called by the edge adapters):
- `POST /v1/relay/{platform}/{operation}` — the metered relay
- `GET /v1/accounts` — what this instance may pull
- `GET /v1/health`

Keep the data plane to **one verb shape** (`relay`) so adding a platform/operation
is config, not new surface.

---

## 6. Security (and the one problem unique to a shared app)

- **Token custody:** KMS envelope encryption at rest; read-only reporting scopes;
  per-account rotation + revocation; tenant isolation enforced in every query.
- **Instance auth:** mTLS client certs or signed long-lived keys; rotate/revoke per
  instance; a compromised instance key exposes only that tenant's *ad reports* (read).
- **The blast-radius problem — mandatory, not optional:** every tenant shares
  whitebox.pro's **one** platform app, so one noisy tenant can exhaust the
  **app-level** rate limit and rate-limit *everyone*. Therefore: **per-tenant token
  buckets** + a **global circuit breaker** per platform + fair-queuing. This is the
  single most important non-obvious requirement of a shared-approval broker.
- **Least privilege + audit:** request only reporting scopes; append-only audit log
  of connects, relays, disconnects, key rotations.
- **PII enforcement as an invariant:** there is deliberately **no endpoint** that
  accepts first-party data; relay bodies are streamed, not persisted; make "gateway
  stores zero insight rows" a tested property.

---

## 7. What whitebox.pro stores — and the precise boundary

**Stores:** tenants, instances, instance keys/certs, connected-account refs,
**encrypted OAuth refresh tokens**, entitlements/plan, **usage events**, audit log.

**Never stores:** customer PII, ad-insight rows (transit only), the instance's
first-party data.

**The honest asterisk (keep it in our own copy):** the gateway **holds ad-account
access tokens** (read-only) and **sees report bodies in transit** (model A forwards
them), but **persists neither the data nor anything about the customer's people.**
"Your customer data never touches our servers; your ad reports pass through and are
never stored." — true, and precise.

---

## 8. Failure modes

| event | gateway behavior | instance sees |
|---|---|---|
| access token expired | token service refreshes transparently | nothing |
| token **revoked** / consent withdrawn | relay 401 + `reconnect_required` | surfaces a "reconnect account" prompt in-product |
| platform 429 (rate limit) | per-tenant backoff; protect the shared app | retryable error + `retry_after` |
| platform outage | circuit breaker per platform | `upstream_unavailable`; **last synced data stays** in the instance |
| instance key compromised | rotate/revoke that key | re-key required |
| gateway down | — | **CDP keeps working**; only *fresh ad data* stalls (degraded ≠ down) |

The last row is the point: the gateway is on the critical path of *fresh paid-media
data*, **not** of the product. A gateway outage never takes the customer's CDP down.

---

## 9. Deployment & tech (thin = small)

- **Relay tier:** stateless, horizontally scalable (any Node/HTTP service); the only
  hot path.
- **Registry/tokens/metering DB:** one small Postgres.
- **Secrets:** a KMS / secret manager (token envelope keys + app vault).
- **Billing:** Stripe metered. **Out of the gateway.**

To start: a single service + one DB + KMS + Stripe. No queue, no scheduler, no data
lake.

---

## 10. What stays at the edge (so the gateway stays thin)

- Report semantics / field maps / normalization → `whitebox-pro-insights-*` (self-hosted, same packages that can also run with BYO creds).
- Sync cadence / scheduling → the instance.
- Insight storage + ROAS join + all PII → the instance.
- Invoicing → Stripe.

If a feature wants to live in the gateway, the default answer is **"push it to the
edge"** unless it needs the shared credentials or the cross-tenant meter.

---

## 11. Open questions

- **Metering unit for billing:** per connected account/month (simplest, matches §9
  of the parent) vs per relay call / per row (usage-true but noisier). Lean
  account/month for v1; the meter store captures call/row detail regardless, so the
  pricing axis can change without re-instrumenting.
- **mTLS vs signed instance keys** for instance auth — pick by ops appetite.
- **Google Ads access model:** MCC + account-link vs per-user OAuth (affects the
  broker's token model the most of the three).
- **Optional relay cache** (short-TTL dedup of identical reports) — cost saver vs
  one more thing to reason about; start without it.
- **Region/data-residency:** EU tenants may want an EU gateway region (the
  design-partner customer is EU) — even though no PII transits, ad data + tokens
  may have residency expectations.
