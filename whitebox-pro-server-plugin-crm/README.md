# CRM Plugin

> Bridges any external system-of-record (booking engine, billing, ticketing, deal pipeline) into a customer's whitebox profile, so the same `/analytics/ask` that already knows what the customer read, watched and emailed about can also answer *"are they an active subscriber?"* and *"when do they check in?"*.

## What it is

A **webhook-only ingestion surface** for records that another system already owns. The CRM (Booking, Stripe, HubSpot, Zendesk, your own admin) pushes records to whitebox whenever they change. Whitebox stores them keyed on the **external system's identity** — `(source, kind, external_id)` — and links each row to the matching whitebox passport.

The plugin is intentionally small. It does not model business workflows, send notifications, or expose a CRM-like UI. It is the **read-mirror keyed on identity** that makes external state visible to whitebox's awareness layer.

## What you get

- **One pane of glass for customer context.** A single `/analytics/ask` call answers both *"have we discussed pricing?"* (semantic recall from emails/calls/web) and *"are they an active customer?"* (structured CRM state) in one grounded LLM response.
- **Two endpoints, two concepts.** `POST /crm/records` writes *structured state* (a reservation, a subscription, a deal) into core **facts**. `POST /crm/facts` ingests *free-text things we know* about the customer (a staff note, a tag, a call summary, an allergy) into **awareness**. Triggers in your CRM map 1:1 — status-change webhooks call `/records`, note-added webhooks call `/facts`. No re-merging.
- **Notes, tags, and free-text fields become searchable memory.** Anything you push to `/crm/facts` lands in the semantic store (`channel: 'crm'`, `direction: 'observation'`) with a stable `content_id`, so re-pushes dedupe and `/analytics/ask` can cite them by timestamp.
- **Zero adapter maintenance on the whitebox side.** No polling, no OAuth flows, no per-vendor SDKs. Third-party APIs change constantly — that complexity lives in *your* CRM glue, not in whitebox.
- **Idempotent ingestion.** Upsert on `(source, kind, external_id)` means re-sending the same payload is safe. Nightly reconciliation is just "replay the last 48h" — no special "sync" mode.
- **GDPR-safe.** State lives in core facts (FK to the passport, cascade) and notes in awareness. Forgetting a passport removes both; the external system still owns the source data and can re-ingest.
- **Identity-first ingestion.** Records arrive attached to identifying info (email / phone / external_id). If a passport with any of those identities already exists, the record links to it and any new identities backfill onto it. If none match, a new passport is created from the CRM-provided identities — the CRM is allowed to be the first system to meet a customer. Only payloads with **no usable identity at all** are dropped.

## How to integrate

### 1. Enable the plugin

```js
// config
{
  plugins: [..., 'crm'],
  crm: {
    auth: { secret: process.env.WHITEBOX_CRM_TOKEN },
  },
}
```

Migration runs on startup. The plugin self-registers a `crm` provider with the context registry so `/analytics/ask` picks it up automatically — no analytics-side change needed.

### 2. Push records when state changes

```js
const HEADERS = {
  'Authorization': `Bearer ${process.env.WHITEBOX_CRM_TOKEN}`,
  'Content-Type': 'application/json',
}

// Wired to your CRM's "object updated" webhook
await fetch('https://wb.example.com/crm/records', {
  method: 'POST', headers: HEADERS,
  body: JSON.stringify({
    source: 'booking',
    customer: { email: guest.email, phone: guest.phone },
    records: [{
      kind: 'reservation',
      external_id: reservation.id,
      status: reservation.status,
      starts_at: reservation.check_in,
      data: { room: reservation.room.type, nights: reservation.nights },
    }],
  }),
})
```

### 3. Push facts when someone writes something

```js
// Wired to your CRM's "note created" / "tag added" / "comment posted" webhook
await fetch('https://wb.example.com/crm/facts', {
  method: 'POST', headers: HEADERS,
  body: JSON.stringify({
    source: 'booking',
    customer: { email: guest.email },
    facts: [{
      id: `note-${note.id}`,                 // stable per-fact id from the source system
      kind: 'note',                          // 'note' | 'tag' | 'call_summary' | …
      body: note.body,
      ts: note.created_at,
      ref: { kind: 'reservation', external_id: reservation.id },  // optional
    }],
  }),
})
```

`ref` is optional. Omit it for customer-level notes (tags, lifetime preferences, allergies). When provided, awareness `meta` carries the `ref` (kind + external_id) plus the resolved `entity` (`kind:external_id`) — the same entity the record's state facts carry, so a note and the state it refers to join on it.

Both routes return the same response shape:

| status | meaning                                                                                      | retry?                   |
|--------|----------------------------------------------------------------------------------------------|--------------------------|
| `200`  | Stored / upserted. `passport_created` tells you whether a new passport was minted.            | no                       |
| `202`  | Payload has no usable identity (no email, no parseable phone, no `external_id`). Dropped.    | **no — fix the payload** |
| `400`  | Validation error (empty array, missing field, bad type). Fix and resend.                     | fix                      |
| `5xx`  | Transient — your retry logic.                                                                 | yes                      |

Two design rules keep it small:

- **The CRM is the source of truth.** Always send the full record / note; the current view is whatever you last sent. No diff protocol.
- **Send on every change.** A nightly replay of the last 48h is a safe retry strategy: records append (current = latest) and notes dedupe on `content_id`, so re-sending is idempotent for state and notes alike.

### 4. Read it back

Either via `/analytics/ask` (which pulls structured CRM context automatically alongside semantic evidence), or directly:

```
GET /crm/records/:passport_id      → { data: { <key>: <value>, … } }  (current state, from facts)
GET /analytics/context/:passport_id?provider=crm
```

For history, transitions, time-travel, or cross-customer queries, use the core query surface (`POST /query`, `POST /ask`) — structured state is core facts.

## Design in one breath

- **Push only.** Whitebox never polls. The external system sends every change as a webhook. Third-party APIs change; maintaining adapters for them is somebody else's problem.
- **A thin adapter, no store of its own.** Structured state lands in the core **facts** memory (`ctx.facts`); the plugin owns no table. A record's `status` becomes a fact keyed by `kind`, each scalar in `data` becomes its own fact, `starts_at` is the fact's `observed_at`, and `(source, external_id)` are the fact's `source` + `entity`. Facts are append-only, so a status change just appends a new row — the current value is the latest and the history powers temporal queries.
- **Queryable by the selector.** Because state is facts, the core query engine filters on it directly: `{ fact: { subscription: { eq: "active" } } }`, `{ fact: { plan_tier: { eq: "pro" } } }`, even transitions (`{ fact: { subscription: { transition: { to: "cancelled" } } } }`). No CRM-specific query path.
- **Identity drives passport resolution.** The CRM must send at least one of `email`, `phone`, or `external_id` in `customer`. The plugin:
  1. Looks for an existing passport that already has any of those identities.
  2. If found, reuses it and **backfills** any identities the existing passport was missing.
  3. If not found, **creates a new passport** and links every identity the CRM provided.
  4. If the payload has no usable identity at all → drops with `202 reason:"no_identity"`.
- **Records and notes on separate routes.** Records carry current state (`POST /crm/records` → facts). Notes carry free-text things we know about the customer (`POST /crm/facts` → awareness). A note may reference a record via `ref: { kind, external_id }` — the ref carries the external identity + `entity` (`kind:external_id`), so a note and the state it refers to join on that entity. Each note becomes an awareness exposure (`channel:'crm'`, `direction:'observation'`) with `content_id = "${source}:fact:${kind}:${id}"` — stable across re-pushes.
- **GDPR-safe.** Facts FK to the passport with cascade; forgetting a passport removes its facts and awareness footprint. The external system still owns the source data and can re-ingest.

## Role

```
┌────────────────────┐
│  External system   │
│  (Booking, Stripe, │
│   HubSpot, …)      │
└──┬──────────────┬──┘
   │              │
   │ POST /crm/records           POST /crm/facts
   │ { source, customer,         { source, customer,
   │   records: [...] }            facts:   [...] }
   ▼                              ▼
┌──────────────────────────────────────────────┐
│ crm plugin (thin adapter, no store)          │
│  ─ shared bearer auth                        │
│  ─ shared resolvePassport (identity gate)    │
│  ─ ingestRecords  │  ingestFacts             │
└──────┬────────────┴──────┬───────────────────┘
       │                   │
       ▼                   ▼
   core facts          core/awareness
(structured state)     (notes: exposures + chunks)
```

## File layout

```
src/plugins/crm/
├── migrations/
│   ├── 001_create_records.js   - (retired)
│   └── 002_drop_records.js     - drops the old table; state is core facts now
├── state.js      - structured-state adapter over ctx.facts
├── ingest.js     - identity resolution + state + awareness writes
├── routes.js     - HTTP routes, Zod
├── mcp.js        - MCP tools
├── index.js      - wiring, auth, context registration
└── README.md
```

## Structured state → core facts

CRM owns no table. Each record maps onto the core **facts** memory:

| record field           | becomes                                                        |
|------------------------|---------------------------------------------------------------|
| `status`               | a fact `key = kind`, `value = status` (the primary signal)    |
| each scalar in `data`  | a fact `key = <field>`, `value = <scalar>` (individually queryable) |
| `starts_at`            | the fact's `observed_at` (the event time → funnel `matched_at`) |
| `source`               | the fact's `source`                                            |
| `(kind, external_id)`  | the fact's `entity` (`kind:external_id`)                       |

Facts are append-only, so a status change appends a new row — the current value is the latest, and the history powers `asOf` time-travel and temporal operators (`transition`, `changed`). Non-scalar `data` fields are skipped (not value-queryable); a record with neither status nor scalar data records a bare presence fact (`key = kind`, `value = true`). Forgetting a passport cascades to its facts.

## Configuration

```js
config.crm = {
  auth: { secret: 'long-random-bearer-token' },
}
```

Add `'crm'` to `config.plugins`. No other config knobs — identity resolution, retry behavior, and payload shape are all decided per-request by the sender.

## Endpoints

### `POST /crm/records`

Upsert structured state. Bearer-authed, JSON body.

**Request**

```json
{
  "source": "booking",
  "customer": {
    "email": "alice@example.com",
    "phone": "+1 555 123 4567",
    "country": "US",
    "external_id": "cust_2841"
  },
  "records": [
    {
      "kind": "reservation",
      "external_id": "res_88421",
      "status": "confirmed",
      "starts_at": "2026-06-12T14:00:00Z",
      "data": {
        "room": "Deluxe Suite",
        "nights": 3,
        "total_eur": 612,
        "guests": 2
      }
    }
  ]
}
```

**Response — happy path** (`200`)

```json
{
  "passport_id": "a1b2c3d4-...",
  "passport_created": false,
  "records": { "accepted": 1, "dropped": 0 }
}
```

`passport_created: true` means whitebox saw this customer for the first time and minted a new passport from the CRM-provided identities.

### `POST /crm/facts`

Ingest free-form things we know about the customer. Bearer-authed, JSON body.

**Request**

```json
{
  "source": "booking",
  "customer": { "email": "alice@example.com" },
  "facts": [
    {
      "id": "note-1",
      "kind": "note",
      "body": "Guest requested late check-in. Wedding anniversary — flowers in room.",
      "ts": "2026-05-20T09:14:00Z",
      "ref": { "kind": "reservation", "external_id": "res_88421" }
    },
    {
      "id": "vip-flag",
      "kind": "tag",
      "body": "VIP — repeat guest, treated as priority"
    }
  ]
}
```

The note with `ref` is tied to the reservation via its `entity` (`reservation:res_88421`) in awareness `meta` — the same entity the reservation's state facts carry. The one without `ref` applies at the customer level — useful for tags, allergies, lifetime preferences.

**Response — happy path** (`200`)

```json
{
  "passport_id": "a1b2c3d4-...",
  "passport_created": false,
  "facts": { "accepted": 2, "dropped": 0 }
}
```

### Response codes — shared by both routes

| status | meaning                                                                                | retry?                   |
|--------|----------------------------------------------------------------------------------------|--------------------------|
| `200`  | Accepted. See `records` or `facts` counters in the body.                                | no                       |
| `202`  | `reason: "no_identity"` — no email / parseable phone / `external_id` in `customer`.     | **no — fix the payload** |
| `400`  | Validation error (empty array, missing field, malformed body).                          | fix                      |
| `5xx`  | Transient — your retry logic.                                                            | yes                      |

**Why two endpoints, not one combined webhook?** Records change frequently and on system triggers (every status flip, every payment retry). Facts are human-written and rare. Splitting them lets your CRM's "object updated" webhook map to `/records` and "note created" webhook map to `/facts` without re-merging two natively separate event streams. It also means rate-limiting, observability, and validation errors are scoped to one concern per URL.

### `GET /crm/records/:passport_id`

Read the passport's **current structured state** back — the `{ key: value }` facts CRM has written for them. A convenience read for admin tools; the full query surface (history, transitions, cross-customer) is core `POST /query`.

Returns `{ data: { <key>: <value>, … } }`.

```bash
curl -H "Authorization: Bearer $WHITEBOX_TOKEN" \
  "https://api.example.com/crm/records/$PASSPORT_ID"
# → { "data": { "subscription": "active", "plan_tier": "pro", "seats": 9 } }
```

## Identity resolution

When a webhook arrives, the ingest builds a claim list from whatever identities the CRM provided:

1. **email** — lowercased
2. **phone** — normalized to E.164 via libphonenumber-js with `customer.country` (default `US`). Unparseable phones are silently dropped from the claim list.
3. **user** — value is `${source}:${external_id}` (typed as the strong `user` identity, scoped per source)

Then:

```
if no claims at all
  → drop the entire payload (202 no_identity)

else
  for each claim, look it up in whitebox_passports_identities
  if any matches an existing passport
    → reuse that passport
    → call passports.link(existingId, allClaims) so any new identities are backfilled
  else
    → passports.identify(null)  to mint a fresh passport
    → call passports.link(newId, allClaims) to attach every identity
```

This is permissive on purpose. The CRM is often the first system to meet a customer (a reservation comes in before they ever visit the site). Whitebox doesn't refuse that — it accepts the CRM as a legitimate first touchpoint. The only thing it refuses is anonymity: a record with zero identifying fields is data with nowhere to go, and we'd rather you fix the payload than create silent orphans.

Why backfill matters: the same customer can be known by email in your booking system and by phone in your billing system. The first CRM push creates a passport with email; the next push from billing arrives with phone, finds the passport by phone OR creates a new one. Either way, sending both `email` and `phone` together accelerates merging — `passports.link()` handles the cross-system reconciliation under the hood.

## Notes → awareness mapping

For each note pushed to `/crm/facts` the plugin calls:

```js
awareness.record({
  passport_id,
  session_id: null,                 // CRM pushes have no web session
  ts: fact.ts || new Date(),
  channel: 'crm',
  direction: 'observation',         // we observed it about them — not exposure, not expression
  source: <payload.source>,
  content_id: `${source}:fact:${fact.kind}:${fact.id}`,
  text: fact.body,
  meta: {
    kind: fact.kind,                              // 'note' | 'tag' | 'call_summary' | ...
    ref: { kind, external_id, entity: `${kind}:${external_id}` },  // when attached to a record
  },
})
```

Three properties to notice:

- **"Note" is the right name.** These are atomic free-text things we know about the customer — a tag, an observation, a note's contents. The LLM in `/analytics/ask` treats them as asserted by the source CRM (not eternal truths). Same epistemological footing as every other awareness exposure. (Typed, value-queryable state goes to `/crm/records` → core facts instead.)
- **`content_id` is derived from the note's own identity**, not from any record's. If the CRM re-attaches a note to a different record, `content_id` stays put — awareness still dedupes it via `content_hash`, no re-embedding.
- **`ref` joins on `entity`, not a row id.** It travels to the LLM via awareness `meta` so `/analytics/ask` can cite *"a note on reservation res_88421 from May 20 said …"*. The `entity` (`kind:external_id`) is exactly what the record's state facts carry, so notes and state join without a stored record id. Push notes independently from the records they reference whenever it's convenient.

These exposures show up in:
- `POST /analytics/recall` — top-k semantic match scoped to the passport
- `POST /analytics/ask` — synthesized answer with the CRM observation cited inline
- `GET /analytics/timeline/:passport_id?channels=crm` — flat history

## End-to-end example: a hotel booking system

Below is what a Node.js booking system would push for the canonical lifecycle of one reservation.

### 0. Shared client helpers

```js
import fetch from 'node-fetch'

const WB = 'https://api.example.com'
const HEADERS = {
  'Authorization': `Bearer ${process.env.WHITEBOX_TOKEN}`,
  'Content-Type': 'application/json',
}

const pushRecords = (payload) => fetch(`${WB}/crm/records`, {
  method: 'POST', headers: HEADERS, body: JSON.stringify(payload),
}).then(r => r.json().then(b => ({ status: r.status, body: b })))

const pushFacts = (payload) => fetch(`${WB}/crm/facts`, {
  method: 'POST', headers: HEADERS, body: JSON.stringify(payload),
}).then(r => r.json().then(b => ({ status: r.status, body: b })))
```

### 1. Reservation created

Wire to the booking system's "reservation created" webhook. State goes through `/records`; if the booking captured a special request at creation time, fire that off through `/facts` in a second call.

```js
async function onReservationCreated(reservation) {
  await pushRecords({
    source: 'booking',
    customer: {
      email: reservation.guest.email,
      phone: reservation.guest.phone,
      country: reservation.guest.country_code,
      external_id: reservation.guest.id,
    },
    records: [{
      kind: 'reservation',
      external_id: reservation.id,
      status: reservation.status,            // 'confirmed' | 'pending' | …
      starts_at: reservation.check_in,
      data: {
        room_type: reservation.room.type,
        nights: reservation.nights,
        total_eur: reservation.total_cents / 100,
        guests: reservation.guest_count,
        channel: reservation.booked_via,     // 'direct' | 'booking.com' | …
      },
    }],
  })

  if (reservation.special_requests) {
    await pushFacts({
      source: 'booking',
      customer: { email: reservation.guest.email },
      facts: [{
        id: `req-${reservation.id}`,
        kind: 'special_request',
        body: reservation.special_requests,
        ref: { kind: 'reservation', external_id: reservation.id },
      }],
    })
  }
}
```

### 2. Status change (records route)

Same `external_id` → upserts the existing row, no duplicate. No `/facts` call because the staff didn't write anything; the row's `status` is the whole signal.

```js
async function onReservationStatusChange(reservation) {
  await pushRecords({
    source: 'booking',
    customer: { email: reservation.guest.email },
    records: [{
      kind: 'reservation',
      external_id: reservation.id,
      status: reservation.status,            // 'checked_in' | 'cancelled' | …
      starts_at: reservation.check_in,
      data: { ...reservation.snapshot },
    }],
  })
}
```

### 3. Staff note added (facts route)

A note pushed on its own — the reservation it references already exists from step 1, no need to re-send it.

```js
async function onNoteAdded(reservation, note) {
  await pushFacts({
    source: 'booking',
    customer: { email: reservation.guest.email },
    facts: [{
      id: `note-${note.id}`,                 // stable per-note id from booking-side
      kind: 'note',
      body: note.body,
      ts: note.created_at,
      ref: { kind: 'reservation', external_id: reservation.id },
    }],
  })
}
```

### 3b. Customer-level tag (facts route, no ref)

"VIP" applies to the customer across every reservation. No `ref` — it stands alone in awareness as a customer-wide observation.

```js
async function onVipFlag(guest) {
  await pushFacts({
    source: 'booking',
    customer: { email: guest.email },
    facts: [{
      id: `vip:${guest.id}`,
      kind: 'tag',
      body: 'VIP — repeat guest, treat as priority',
    }],
  })
}
```

### 4. Customer is new to whitebox

```js
const result = await pushRecords({
  source: 'booking',
  customer: { email: 'never-heard-of-them@example.com' },
  records: [{ kind: 'reservation', external_id: 'r-1', data: {} }],
})
// → { status: 200, body: {
//      passport_id: '…', passport_created: true,
//      records: { accepted: 1, dropped: 0 },
//    } }
//
// A fresh passport is minted with the email linked. The next inbound email,
// web visit, or call from this customer will merge into the same passport
// because email is a strong identity.
```

### 4b. Payload has no identity at all (don't do this)

```js
const result = await pushRecords({
  source: 'booking',
  customer: {},                              // no email, no phone, no external_id
  records: [{ kind: 'reservation', external_id: 'r-2', data: {} }],
})
// → { status: 202, body: {
//      reason: 'no_identity',
//      records: { accepted: 0, dropped: 1 },
//    } }
//
// Action: this is a payload bug. Fix the sender to include at least one of
// email / phone / external_id. Do NOT retry — the situation isn't transient.
```

### 5. Nightly reconciliation (recommended)

```js
// At 04:00, replay all reservations that touched the last 48h. Idempotent
// because of the (source, kind, external_id) upsert.
async function reconcileLast48h() {
  const since = new Date(Date.now() - 48 * 3600_000)
  const reservations = await db.reservations.where('updated_at', '>=', since)
  for (const r of reservations) {
    await pushRecords(buildRecordsPayload(r))
    // Notes are re-played separately because they live in their own table.
    const notes = await db.notes.where({ reservation_id: r.id })
    if (notes.length) await pushFacts(buildFactsPayload(r, notes))
  }
}
```

This catches anything that failed on the live webhook (network blip, whitebox restart) **and** picks up customers who became known to whitebox in the meantime.

## End-to-end example: a Stripe billing system

```js
// One push per subscription event (created / updated / cancelled).
async function pushSubscription(sub, customer) {
  await pushRecords({
    source: 'stripe',
    customer: {
      email: customer.email,
      external_id: customer.id,           // 'cus_…'
    },
    records: [{
      kind: 'subscription',
      external_id: sub.id,                // 'sub_…'
      status: sub.status,                 // 'active' | 'past_due' | 'canceled'
      starts_at: new Date(sub.current_period_start * 1000).toISOString(),
      data: {
        plan: sub.items.data[0].price.lookup_key,
        amount_eur: sub.items.data[0].price.unit_amount / 100,
        interval: sub.items.data[0].price.recurring.interval,
        cancel_at_period_end: sub.cancel_at_period_end,
      },
    }],
  })
}

// Failed payment as a separate kind so it has its own external_id and
// shows up distinctly in awareness. The error message goes through /facts
// referencing the payment_failure record.
async function pushPaymentFailure(invoice, customer) {
  await pushRecords({
    source: 'stripe',
    customer: { email: customer.email },
    records: [{
      kind: 'payment_failure',
      external_id: invoice.id,
      status: 'failed',
      starts_at: new Date(invoice.created * 1000).toISOString(),
      data: {
        amount_eur: invoice.amount_due / 100,
        attempt_count: invoice.attempt_count,
        next_attempt: invoice.next_payment_attempt
          ? new Date(invoice.next_payment_attempt * 1000).toISOString()
          : null,
      },
    }],
  })

  if (invoice.last_finalization_error) {
    await pushFacts({
      source: 'stripe',
      customer: { email: customer.email },
      facts: [{
        id: `${invoice.id}:last-error`,
        kind: 'payment_error',
        body: invoice.last_finalization_error.message,
        ref: { kind: 'payment_failure', external_id: invoice.id },
      }],
    })
  }
}
```

After both calls, `/analytics/ask` will answer questions like *"has this customer had billing issues recently?"* with the failed-invoice observation cited by timestamp.

## Operational properties

- **No worker.** Ingestion is synchronous in the HTTP request — `/crm/records` returns when rows are upserted; `/crm/facts` returns when facts are queued to awareness's embedding worker.
- **No retries on the whitebox side.** A `5xx` is the sender's problem to retry. We log and move on.
- **Idempotent.** Re-pushing the same payload is safe on either route. Test by enabling at-least-once delivery in your CRM's webhook system.
- **Per-route accept/drop counters.** Each route's array is processed sequentially with a counter. For strict per-item failure isolation, send one record (or one fact) per request.
- **Migrations.** Owned by the plugin, run on startup via `plugins.js`.

## What this plugin is NOT

- **Not a CRM.** It doesn't manage status transitions, send notifications, or model business workflows. It's a read-mirror keyed on identity.
- **Not an event log.** Upsert replaces. If you need history, send a new `kind` (e.g. `reservation_change`) with its own `external_id`.
- **Not a polling integration.** No cron, no adapter pattern, no OAuth flow. Senders push.
- **Not an anonymous-data sink.** A push arriving without any identity (no email, no parseable phone, no `external_id`) is rejected at ingest with `202 no_identity`. Passport creation is fine — orphans are not.
- **Not a public endpoint.** The bearer secret is the only thing between an attacker and your customer's CRM rows. Treat it as production-critical.

## Test coverage

```
tests/plugins/crm/ingest.test.js   13 tests
  shared identity gate (both routes):
    - drops records when customer has no identity
    - drops facts when customer has no identity
    - drops on unparseable phone with no other identity
    - returns empty_payload on missing/empty arrays
    - creates new passport on first sight
    - backfills identities onto an existing passport
  ingestRecords:
    - records each record's state into facts and returns counters
    - counts a failed state write as dropped without aborting the batch
  ingestFacts:
    - customer-level note (no ref) lands in awareness
    - a ref carries the external identity + entity (joins to state facts)
    - content_id is stable across re-pushes, independent of ref
    - skips notes without a body
  state (records → facts):
    - status → fact keyed by kind; each scalar in data → its own fact
    - skips non-scalar data; bare presence fact when nothing else

tests/plugins/crm/index.test.js     2 tests
  - registers a context provider that reads back the passport's facts
  - loads without context registry
```

## Known gaps

1. **No batch endpoint.** One HTTP request per CRM event. For very high volume (>100/s sustained), add a queue between your CRM and the webhook caller — not on the whitebox side.
2. **Append-only, latest-wins.** A status change appends a new fact (the history is the point); a `data` field that disappears keeps its last value. Send the full record each time.
3. **One entity per kind, latest in the current view.** Multiple live entities of the same `kind` (two subscriptions) share a `key`; the current value is the most recent. The `entity` distinguishes them in history, but the selector's `filter.fact` reads the latest per key.
4. **Non-scalar `data` is not queryable.** Object/array fields are skipped (only scalars become facts). Flatten upstream if you need to filter on them.
5. **No webhook signing.** Bearer auth only. If you need replay protection, terminate at a proxy that verifies an HMAC header before forwarding.
