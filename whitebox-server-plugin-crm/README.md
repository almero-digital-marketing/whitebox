# CRM Plugin

> Bridges any external system-of-record (booking engine, billing, ticketing, deal pipeline) into a customer's whitebox profile, so the same `/analytics/ask` that already knows what the customer read, watched and emailed about can also answer *"are they an active subscriber?"* and *"when do they check in?"*.

## What it is

A **webhook-only ingestion surface** for records that another system already owns. The CRM (Booking, Stripe, HubSpot, Zendesk, your own admin) pushes records to whitebox whenever they change. Whitebox stores them keyed on the **external system's identity** — `(source, kind, external_id)` — and links each row to the matching whitebox passport.

The plugin is intentionally small. It does not model business workflows, send notifications, or expose a CRM-like UI. It is the **read-mirror keyed on identity** that makes external state visible to whitebox's awareness layer.

## What you get

- **One pane of glass for customer context.** A single `/analytics/ask` call answers both *"have we discussed pricing?"* (semantic recall from emails/calls/web) and *"are they an active customer?"* (structured CRM state) in one grounded LLM response.
- **Two endpoints, two concepts.** `POST /crm/records` upserts *structured state* (a reservation, a subscription, a deal). `POST /crm/facts` ingests *things we know* about the customer (a staff note, a tag, a call summary, an allergy). Triggers in your CRM map 1:1 — status-change webhooks call `/records`, note-added webhooks call `/facts`. No re-merging.
- **Notes, tags, and free-text fields become searchable memory.** Anything you push to `/crm/facts` lands in the semantic store (`channel: 'crm'`, `direction: 'observation'`) with a stable `content_id`, so re-pushes dedupe and `/analytics/ask` can cite them by timestamp.
- **Zero adapter maintenance on the whitebox side.** No polling, no OAuth flows, no per-vendor SDKs. Third-party APIs change constantly — that complexity lives in *your* CRM glue, not in whitebox.
- **Idempotent ingestion.** Upsert on `(source, kind, external_id)` means re-sending the same payload is safe. Nightly reconciliation is just "replay the last 48h" — no special "sync" mode.
- **GDPR-safe.** `passport_id` is `ON DELETE SET NULL`. Forgetting a passport removes the awareness footprint but keeps the CRM-owned row intact (the external system still owns it).
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

`ref` is optional. Omit it for customer-level facts (tags, lifetime preferences, allergies). When provided, awareness `meta` carries both `ref` and a resolved `record_id` (if the referenced record exists in `whitebox_crm_records` already).

Both routes return the same response shape:

| status | meaning                                                                                      | retry?                   |
|--------|----------------------------------------------------------------------------------------------|--------------------------|
| `200`  | Stored / upserted. `passport_created` tells you whether a new passport was minted.            | no                       |
| `202`  | Payload has no usable identity (no email, no parseable phone, no `external_id`). Dropped.    | **no — fix the payload** |
| `400`  | Validation error (empty array, missing field, bad type). Fix and resend.                     | fix                      |
| `5xx`  | Transient — your retry logic.                                                                 | yes                      |

Two design rules keep it small:

- **The CRM is the source of truth.** Always send the full record / fact; whitebox replaces on upsert. No diff protocol.
- **Send on every change.** A nightly replay of the last 48h is the recommended retry strategy because the upserts on both routes are idempotent.

### 4. Read it back

Either via `/analytics/ask` (which pulls structured CRM context automatically alongside semantic evidence), or directly:

```
GET /crm/records/:passport_id?source=booking&kind=reservation&limit=50&offset=0
GET /analytics/context/:passport_id?provider=crm&limit=20&offset=0
```

## Design in one breath

- **Push only.** Whitebox never polls. The external system sends every change as a webhook. Third-party APIs change; maintaining adapters for them is somebody else's problem.
- **Upsert by external identity.** `(source, kind, external_id)` is the unique key. Re-sending the same payload replaces `status`, `starts_at`, `data` and bumps `updated_at`. No history, no event log — the CRM is already the source of truth.
- **Identity drives passport resolution.** The CRM must send at least one of `email`, `phone`, or `external_id` in `customer`. The plugin:
  1. Looks for an existing passport that already has any of those identities.
  2. If found, reuses it and **backfills** any identities the existing passport was missing.
  3. If not found, **creates a new passport** and links every identity the CRM provided.
  4. If the payload has no usable identity at all → drops with `202 reason:"no_identity"`.
- **Records and facts on separate routes.** Records carry current state (`POST /crm/records`). Facts carry things we know about the customer (`POST /crm/facts`). A fact may reference a record via `ref: { kind, external_id }`, or stand alone for customer-level observations (tags, allergies, lifetime preferences). Each fact becomes an awareness exposure (`channel:'crm'`, `direction:'observation'`) with `content_id = "${source}:fact:${kind}:${id}"` — stable across re-pushes and independent of which record it's attached to.
- **GDPR-safe.** `passport_id` is `ON DELETE SET NULL`. A `DELETE /analytics/passport/:id` removes the awareness footprint but leaves the CRM-owned row in place — the external system still owns it.

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
│ crm plugin                                   │
│  ─ shared bearer auth                        │
│  ─ shared resolvePassport (identity gate)    │
│  ─ ingestRecords  │  ingestFacts             │
└──────┬────────────┴──────┬───────────────────┘
       │                   │
       ▼                   ▼
whitebox_crm_records   core/awareness
(structured state)     (exposures + chunks)
```

## File layout

```
src/plugins/crm/
├── migrations/
│   └── 001_create_records.js
├── records.js     - upsert / find / list data layer
├── ingest.js      - identity resolution + record + awareness writes
├── index.js       - HTTP routes, Zod, auth
└── README.md
```

## Table: `whitebox_crm_records`

| column        | type      | notes                                              |
|---------------|-----------|----------------------------------------------------|
| id            | serial PK |                                                    |
| passport_id   | uuid      | FK → passports, **SET NULL** on passport delete    |
| source        | string    | `'booking'`, `'stripe'`, `'hubspot'`, …            |
| kind          | string    | `'reservation'`, `'subscription'`, `'deal'`, …     |
| external_id   | string    | CRM-side row id                                    |
| status        | string?   | free-form CRM status                               |
| starts_at     | timestamp?| event time (check-in, due date, …)                 |
| data          | jsonb     | full CRM payload, shape is CRM-specific            |
| created_at    | timestamp |                                                    |
| updated_at    | timestamp | bumped on every upsert                             |

Unique: `(source, kind, external_id)`. Indexes on `passport_id`, `(source, kind)`, `starts_at`.

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

The fact with `ref` is attached to the reservation (awareness `meta.record_id` is populated via DB lookup if the record exists). The one without `ref` applies at the customer level — useful for tags, allergies, lifetime preferences.

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

Read records back for a known passport. Useful for admin tools.

Query params: `source`, `kind`, `limit` (default 50, max 500), `offset`. Ordered by `starts_at` desc. Returns the standard `{ data, limit, offset, has_more }` pagination envelope.

```bash
curl -H "Authorization: Bearer $WHITEBOX_TOKEN" \
  "https://api.example.com/crm/records/$PASSPORT_ID?source=booking&kind=reservation"
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

## Facts → awareness mapping

For each fact pushed to `/crm/facts` the plugin calls:

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
    ref: fact.ref || undefined,                   // { kind, external_id } when attached to a record
    record_id: <row.id of the referenced record, if it exists in whitebox_crm_records>,
  },
})
```

Three properties to notice:

- **"Fact" is the right name.** These are atomic things we know about the customer — a tag, an observation, a note's contents. The LLM in `/analytics/ask` treats them as facts asserted by the source CRM (not as eternal truths). Same epistemological footing as every other awareness exposure.
- **`content_id` is derived from the fact's own identity**, not from any record's. If the CRM re-attaches a note to a different record, `content_id` stays put — awareness still dedupes it via `content_hash`, no re-embedding.
- **`ref` is metadata, not structure.** It travels to the LLM via awareness `meta` so `/analytics/ask` can cite *"a note on reservation res_88421 from May 20 said …"*, but the storage doesn't care whether the referenced record exists, exists in a separate push, or exists in a different source. Push facts independently from the records they reference whenever it's convenient. `record_id` is populated only when a matching row already lives in `whitebox_crm_records`; otherwise `ref` alone carries the external identity for future joins.

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
    - upserts with passport linkage and returns counters
    - counts a failed upsert as dropped without aborting the batch
  ingestFacts:
    - customer-level fact (no ref) lands in awareness
    - resolves ref to record_id via DB lookup when the record exists
    - omits record_id but keeps ref when record isn't (yet) stored
    - content_id is stable across re-pushes, independent of ref
    - skips facts without a body

tests/plugins/crm/index.test.js     2 tests
  - registers compact provider with context registry
  - loads without context registry
```

## Known gaps

1. **No batch endpoint.** One HTTP request per CRM event. For very high volume (>100/s sustained), add a queue between your CRM and the webhook caller — not on the whitebox side.
2. **No partial updates.** `data` is replaced wholesale on upsert. Senders must always push the full record, not a diff.
3. **No delete endpoint.** A record can only be deleted via direct SQL or a future admin endpoint. `ON DELETE SET NULL` keeps the row when its passport is GDPR-forgotten.
4. **No schema-per-source enforcement.** `data` is `jsonb` and anything passes Zod's `record(any)`. Each CRM is free-form. Add per-source validation client-side if you need it.
5. **No webhook signing.** Bearer auth only. If you need replay protection, terminate at a proxy that verifies an HMAC header before forwarding.
