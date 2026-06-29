# Gateway — metering & Stripe billing model

> **Companion to** [`whitebox-connect-gateway.md`](whitebox-connect-gateway.md)
> (§3.3 meter step + §3.4 billing pipeline + §6 entitlement/quota). The last
> unspecified gateway subsystem. **Status:** design / not started.

---

## 1. The key separation

Two signals, deliberately decoupled:

- **Usage events** — fine-grained, one per successful metered relay call. For
  **analytics, quota, audit, and a future usage-based price**. Idempotent. Written
  on the hot path but **non-billing-critical**.
- **Billing quantity** — in v1, the **count of connected ad accounts** (a coarse,
  reliable signal from the registry), reported to Stripe as a quantity-based
  subscription. Driven by **account connect/disconnect** (rare, transactional), not
  by call volume.

Why decouple: a metering insert can fail (or be dropped under load) without
affecting either the customer's relay **or** their invoice — the bill comes from the
account registry, not the event stream. And because the events are still captured,
switching to usage-based pricing later needs **no re-instrumentation** (§7).

This keeps the promise from the gateway doc: *"the meter store captures call/row
detail regardless, so the pricing axis can change without re-instrumenting."*

---

## 2. Pricing decision (v1)

**Per connected ad account, per month** — quantity-based (licensed) Stripe
subscription. Simple to reason about, matches Windsor's axis, and the customer
controls cost by what they connect. One flat per-account price in v1 (platform-
differentiated pricing is a later option). Door stays open to **usage-based**
(per call/row via Stripe Billing Meters) once a customer wants pay-per-use.

---

## 3. Data model

`whitebox-pro-connect/src/migrations/00X_billing.js` (repo knex style):

```js
// Connect billing & metering. Usage = fine-grained analytics/quota (idempotent,
// non-billing-critical). v1 BILLING quantity = connected accounts from the registry,
// pushed to Stripe as a quantity-based subscription item. Billing is OFF the relay
// hot path, so a metering write can fail without touching the call or the invoice.

export async function up(knex) {
  // append-only usage log — one row per successful metered relay call
  await knex.schema.createTable('whitebox_connect_usage', t => {
    t.uuid('id').primary()
    t.uuid('tenant_id').notNullable()
    t.uuid('instance_id')
    t.text('platform').notNullable()                 // 'meta' | 'google' | 'tiktok'
    t.text('account_id').notNullable()
    t.text('operation').notNullable()                // 'insights.query' | ...
    t.text('idempotency_key').notNullable()          // = the relay call's key; dedups retries
    t.integer('units').notNullable().defaultTo(1)
    t.integer('rows')                                // rows returned (row-based pricing later)
    t.bigInteger('bytes')
    t.timestamp('occurred_at', { useTz: true }).defaultTo(knex.fn.now())
    t.unique(['tenant_id', 'idempotency_key'])       // ON CONFLICT DO NOTHING ⇒ retries metered once
    t.index(['tenant_id', 'occurred_at'])
    t.index(['tenant_id', 'platform', 'account_id'])
  })

  // per-tenant Stripe linkage + billing status (status gates relays via entitlement)
  await knex.schema.createTable('whitebox_connect_billing', t => {
    t.uuid('tenant_id').primary()
    t.text('stripe_customer_id')
    t.text('stripe_subscription_id')
    t.text('stripe_item_id')                         // the per-account quantity item
    t.text('plan').notNullable().defaultTo('connect_standard')
    t.text('status').notNullable().defaultTo('trialing')  // trialing|active|past_due|canceled
    t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now())
  })
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('whitebox_connect_usage')
  await knex.schema.dropTableIfExists('whitebox_connect_billing')
}
```

The **billable quantity** is derived from the gateway's account registry
(`whitebox_connect_accounts`, defined with the registry): `count(accounts WHERE
tenant_id = ? AND status <> 'disconnected')`. A `reconnect_required` account still
counts as connected (don't penalize the customer for a token expiry) — only an
explicit **disconnect** stops billing.

---

## 4. The four flows

### 4.1 Metering capture (hot path — fire-and-forget, never fails the relay)

```js
// in the relay handler, AFTER a successful upstream response
function meter(ev) {
  db('whitebox_connect_usage')
    .insert({ id: randomUUID(), ...ev })
    .onConflict(['tenant_id', 'idempotency_key']).ignore()   // retried call ⇒ no double count
    .catch(e => logger.warn(`meter drop: ${e.message}`))     // never propagate to the customer's call
}
// meter({ tenant_id, instance_id, platform, account_id, operation, idempotency_key, units: 1, rows })
```

Only successful (2xx upstream) relays are metered; errors are not billed. The
`idempotency_key` is the relay call's key (the [relay client](whitebox-connect-relay-client.md)
reuses one key across a call's retries), so the unique constraint makes retries a
no-op.

### 4.2 Billing sync (account lifecycle → Stripe quantity — idempotent set-to-count)

```js
async function syncQuantity(tenant_id) {
  const [{ n }] = await db('whitebox_connect_accounts')
    .where({ tenant_id }).whereNot('status', 'disconnected').count({ n: '*' })
  const b = await ensureSubscription(tenant_id)              // lazily creates customer+sub+item on 1st connect
  await stripe.subscriptionItems.update(
    b.stripe_item_id,
    { quantity: Number(n) },                                 // Stripe prorates the change
    { idempotencyKey: `qty:${tenant_id}:${n}` },             // safe to retry
  )
}
// called (debounced) on every connect/disconnect + a nightly reconcile
```

**Set-to-count, not delta** — reporting the absolute account count (rather than
+1/−1) is drift-proof and idempotent; a missed or double-fired event self-heals on
the next sync or the nightly reconcile. `ensureSubscription` creates the Stripe
customer + subscription (the per-account/month price) on the first connect and
stores the ids, defaulting to `trialing`.

### 4.3 Stripe webhooks (billing status back — gates relays)

```js
// POST /v1/stripe/webhook  (signature-verified)
const tenant = await tenantByCustomer(event.data.object.customer)
switch (event.type) {
  case 'customer.subscription.updated':
  case 'customer.subscription.deleted':
    await setStatus(tenant, event.data.object.status); break   // active|past_due|canceled|…
  case 'invoice.payment_failed': await setStatus(tenant, 'past_due'); break
  case 'invoice.paid':           await setStatus(tenant, 'active');   break
}
```

`setStatus` writes `whitebox_connect_billing.status` and busts the billing cache the
entitlement check reads.

### 4.4 Entitlement gate (relay authz — hot path, the loop-closer)

```js
function entitled(tenant, platform) {
  const b = billingCache.get(tenant)                         // refreshed on webhook
  if (!b || !['trialing', 'active'].includes(b.status)) return false  // non-payment ⇒ blocked
  return planCovers(b.plan, platform)
}
// false ⇒ gateway returns 403 { error: { code: 'entitlement' } }
```

This closes the billing loop: non-payment → Stripe webhook → `past_due` → relays
return `entitlement` → the relay client maps it → the channel `flagEntitlement` →
the WhiteBox UI shows a billing notice. Rate **quota** (the shared-app blast-radius
limit from gateway §6) is enforced separately at the relay tier with a per-tenant
token bucket — **not** a DB scan — so it stays off the hot DB path.

---

## 5. Stripe object mapping

| Stripe object | maps to |
|---|---|
| Product "WhiteBox Connect" | the service |
| Price (recurring, per-unit, monthly) | per connected account / month (v1: one flat price) |
| Customer | a tenant |
| Subscription | the tenant's plan |
| Subscription **item** `quantity` | **count of connected accounts** (§4.2) |
| Webhooks | drive `billing.status` (§4.3) |
| *(future)* Billing **Meter** + metered Price + meter events | usage-based pricing from the already-captured `whitebox_connect_usage` |

All Stripe writes pass an **`idempotencyKey`** so retries never double-charge.

---

## 6. Idempotency & retention

- **Usage dedup:** `UNIQUE(tenant_id, idempotency_key)` + `ON CONFLICT DO NOTHING`
  (permanent — simpler than a TTL window; the relay client guarantees one key per
  logical call).
- **Stripe dedup:** `idempotencyKey` on every API call.
- **Retention:** `whitebox_connect_usage` grows ~one row per relay call —
  partition by month and prune older than the analytics window (e.g. 13 months).
  Billing never depends on it, so pruning is safe.

---

## 7. What stays OUT of the gateway (thin)

- Invoicing, tax, proration math, dunning emails, the customer billing portal →
  **Stripe**. The gateway only: reports the **quantity**, captures **usage**, reacts
  to **webhooks**, and **gates relays** on status.
- Switching to usage-based later is additive: define a Stripe Meter, forward the
  already-captured usage as meter events, attach a metered price — **no new
  instrumentation**, because §4.1 already records every call.

---

## 8. Open questions

- **Pricing granularity:** one flat per-account price vs per-platform (Google ≠
  TikTok value). Start flat.
- **Trial:** length + whether it's card-required; `trialing` already counts as
  entitled.
- **Grace on `past_due`:** block relays immediately vs a short grace window before
  gating (kinder UX). Lean small grace, then gate.
- **Reconnect_required ≠ billing pause:** confirmed — a token expiry keeps the
  account billable; only explicit disconnect stops it.
- **Multi-currency billing:** Stripe bills in the customer's currency; the
  per-account price needs a currency per region (the design-partner customer is EU).
