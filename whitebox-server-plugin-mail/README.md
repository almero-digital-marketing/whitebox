# Mail Plugin

> Transactional, marketing, and contact-form email — sent, tracked, suppression-managed, and fed into the per-passport semantic memory so every message becomes part of `/analytics/ask` evidence.

## What it is

The email **handshake** for whitebox: outbound sending (transactional + bulk), inbound capture (contact forms and Mailgun replies), tracking-webhook ingestion, and the two block lists every production sender needs (unsubscribed / hard-bounced).

It's not a thread tracker. The company's real email client owns multi-turn conversations — this plugin captures the *first* and *last* hop of each touch (we sent X, they replied Y) and routes anything in between as a forward to a designated company inbox. The point isn't to replace the inbox, it's to make the messages part of the customer's awareness profile.

## What you get

- **One outbound API for everything.** `POST /mail/outbox` (single) and `POST /mail/bulk` (up to 10k recipients) share the same template engine, per-recipient `data`, suppression checks, idempotency, and retry semantics.
- **Public contact-form intake.** `POST /mail/inbox` accepts multipart form posts (no auth, signature-verified or rate-gated at your proxy), saves attachments, forwards to the company inbox, and links the submitter to a passport — with strong/weak identities pulled from form fields (email, phone, name, address, URLs). It is inbound-only: it never sends mail back to the submitter. For an acknowledgment auto-reply, subscribe to the `mail.received` event and send via `POST /mail/outbox`.
- **Mailgun delivery + reply webhooks.** Signed inbound (`POST /mail/webhooks/inbox`) and tracking (`POST /mail/webhooks/tracking`) routes turn delivered/opened/clicked/bounced into a rank-ordered status machine you can subscribe to via notify events.
- **Two block lists, two reasons.** `suppressions` (user opt-out, reversible) and `invalid` (technical undeliverability, permanent) — both auto-populated from webhooks and exposed as CRUD endpoints.
- **Messages become memory.** Every send and every inbound is fed to `core/awareness` with channel `mail`, so `/analytics/ask` can later answer *"have we told this customer about the refund policy?"* and cite the exact email.
- **Identity gravity.** Form submissions attach phone/name/address/URL identities to the sender's passport (deduped, libphonenumber-validated, no body-text scraping). Subsequent calls from the same phone or visits with the same email merge automatically.
- **Stuck-row reaper.** Outbox jobs that never resolved after 10 minutes are marked failed so workers can't accidentally double-send on restart.

## How to integrate

### 1. Enable the plugin

```js
// config
{
  plugins: [..., 'mail'],
  mail: {
    attachmentsFolder: '/var/lib/whitebox/mail/attachments',
    company: 'info@example.com',                  // forward target for /mail/inbox
    mailgun: {
      apiKey: process.env.MAILGUN_KEY,
      domain: 'mail.example.com',
      webhookSigningKey: process.env.MAILGUN_HMAC,
    },
    auth: { secret: process.env.WHITEBOX_MAIL_TOKEN },
  },
}
```

Migrations run on startup. The plugin self-registers `mail.*` notify topics — anything that subscribes to `core/events` will see queued / sent / delivered / opened / bounced / received events.

### 2. Send a transactional email

```js
await fetch('https://wb.example.com/mail/outbox', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${process.env.WHITEBOX_MAIL_TOKEN}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    to: customer.email,
    subject: 'Your reservation is confirmed',
    template: 'reservation-confirmed',             // mikser layout id (optional)
    data: { room: 'Deluxe Suite', nights: 3 },     // per-recipient context
    idempotency_key: `confirm:${reservation.id}`,  // optional dedup key
  }),
})
```

If you provide `html` / `text` directly you can skip `template`. `data` keys override row columns at render time, so the same template can be reused per recipient.

### 3. Send a bulk campaign

Same shape, but `to` becomes `recipients[]`, with per-recipient `data`:

```js
await POST('/mail/bulk', {
  subject: 'Spring deals — {{name}}',
  template: 'spring-2026',
  recipients: customers.map(c => ({
    to: c.email,
    data: { name: c.first_name, code: c.promo_code },
  })),
})
// → 202 { batch_id, accepted, skipped_suppressed, skipped_invalid, duplicates }
```

Each recipient is checked against `suppressions` and `invalid` before queueing. The plugin returns counts so you know how many actually made it.

### 4. Ingest contact-form submissions

Mount your form to POST to whitebox directly (no proxy needed):

```html
<form action="https://wb.example.com/mail/inbox" method="POST" enctype="multipart/form-data">
  <input name="from"    type="email"    required>
  <input name="subject" type="text"     required>
  <input name="phone"   type="tel">                 <!-- becomes a strong identity -->
  <input name="name"    type="text">                <!-- weak identity, merge hint -->
  <textarea name="body"></textarea>
  <input name="files"   type="file" multiple>
  <input type="submit">
</form>
```

The plugin forwards to `config.mail.company` and links the submitter to a whitebox passport. Add hidden `utm_*` fields if you want campaign attribution to flow into awareness.

### 5. Wire Mailgun webhooks

In Mailgun, point both *Inbound* and *Tracking* webhooks at:

```
POST https://wb.example.com/mail/webhooks/inbox      (multipart, signed)
POST https://wb.example.com/mail/webhooks/tracking   (JSON, signed)
```

No auth — Mailgun signs each request and the plugin verifies HMAC + replay window. Bounces and complaints automatically populate the respective block lists.

### 6. Subscribe to events

Either via the global notify webhooks (`config.mail.webhooks: [...]`) or by registering an in-process listener on `core/events`:

```js
events.on('mail.bounced', ({ data }) => {
  // data.to is already on the invalid list — react however you want
})
```

## File layout

```
src/plugins/mail/
├── index.js          - Plugin entry; wires everything, mounts routes
├── outbox.js         - Send queue, worker, HTTP /outbox, batch ops
├── inbox.js          - Form submissions + Mailgun inbound webhook
├── bulk.js           - Bulk send with per-recipient data
├── tracking.js       - Mailgun delivery webhook handler
├── mailer.js         - Thin nodemailer + Mailgun transport wrapper
├── attachments.js    - UUID-named file storage
├── signature.js      - Mailgun webhook signature verification
├── suppressions.js   - User opt-out list (unsubscribed/complained)
├── invalid.js        - Technical undeliverability list (bounced/rejected)
└── migrations/
    ├── 001 create_inbox
    ├── 002 create_outbox
    ├── 003 outbox_idempotency
    ├── 004 outbox_attachments     (text[])
    ├── 005 inbox_attachments       (text[])
    ├── 006 outbox_template
    ├── 007 outbox_from
    ├── 008 inbox_body_html
    ├── 009 create_suppressions
    ├── 010 create_invalid
    ├── 011 outbox_batch            (batch_id, data jsonb)
    └── 012 outbox_cancelled
```

## Core flows

### Single send

```
POST /mail/outbox (auth)
  ↓ Zod validate (Refine: html|text|template required)
  ↓ resolve session, fetch URL attachments, save file attachments
  ↓ outbox.create() — insert row with idempotency-key dedup
  ↓ outboxQueue.add(jobId = idempotency-key)
  ↓ notify mail.queued
  ← 200 row

Worker picks up:
  ↓ find row, exit if not 'queued'
  ↓ preflightBlock(to) — check invalid + suppressions → fail+notify
  ↓ identify/link recipient to passport
  ↓ render template via mikser (data overrides row fields)
  ↓ mailer.send (Mailgun)
      ↳ permanent error (4xx or keyword) → invalid.add + fail terminal (no retry)
      ↳ transient → throw → BullMQ retry with exponential backoff
  ↓ outbox.sent() — store mailgun_id, mark sent
  ↓ notify mail.sent
```

### Bulk send

```
POST /mail/bulk (auth)
  ↓ Zod validate (max 10k recipients)
  ↓ dedupe by normalized email
  ↓ checkMany() against suppressions + invalid — one query each
  ↓ saveUrl() attachments once for the whole batch
  ↓ outbox.createMany() — single INSERT
  ↓ outboxQueue.addBulk() — single Redis op
  ↓ notify mail.bulk.queued
  ← 202 { batch_id, accepted, skipped_*, duplicates }

GET /mail/bulk/:batchId            → status counts (GROUP BY status)
POST /mail/bulk/:batchId/cancel    → cancel queued rows in batch
```

### Inbound — contact form

```
POST /mail/inbox (public, multer.array('files'))
  ↓ Zod validate
  ↓ resolve session, link passport via from
  ↓ saveBuffer() each file → UUID URLs
  ↓ insert inbox row (source='form')
  ↓ forwardQueue.add() — async forward
  ↓ notify mail.received
  ← 200 row

forward worker:
  mailer.send(to=company, replyTo=customer, text+html+attachments)
```

### Inbound — Mailgun webhook (replies, ad-hoc)

```
POST /mail/webhooks/inbox (multer.any())
  ↓ signature.verify('Inbound')
  ↓ stripped-text || body-plain → body
    body-html → body_html (raw, sanitize on render)
  ↓ saveBuffer() any attachments
  ↓ identify/link sender passport
  ↓ insert inbox row (source='inbound')
  ↓ notify mail.received
  ← 200
```

No forward — Mailgun routes handle that.

### Tracking webhook

```
POST /mail/webhooks/tracking (no auth — signed)
  ↓ signature.verify('Tracking')
  ↓ status map: delivered/opened/clicked→engaged/failed→bounced/complained
  ↓ outbox.track() — advances status only if higher rank (no regression)
  ↓ notify mail.<status>
  ↓ classify side-effects:
      unsubscribed/complained → suppressions.add
      failed + severity=permanent → invalid.add (bounced)
```

## The two block lists

| List | Source | Reversible | Meaning |
|---|---|---|---|
| `suppressions` | unsubscribed/complained webhooks + manual API | yes (re-subscribe) | user intent — "I shouldn't send" |
| `invalid` | hard bounces + mailer.send 4xx/keyword + manual | no | technical — "I can't send" |

Both are checked in the outbox worker's `preflightBlock()`. Both expose CRUD APIs at `/mail/suppressions` and `/mail/invalid`.

`invalid.classifyMailerError(err)` decides if a send error is permanent (4xx status OR matches `/invalid|no recipients|syntax|address rejected|not a valid email|free user|not allowed|does not exist|user unknown|mailbox/i`). Permanent → block address forever; transient → retry.

## Outbox status machine

```
queued ──── worker fetches ────► sent ──► delivered ──► opened ──► engaged
   │                                                          │
   │                                                          ├──► bounced
   │                                                          ├──► complained
   ▼
failed
   ├ retries exhausted
   ├ permanent send error (no retry)
   ├ recipient suppressed/invalid (preflight)
   └ stuck (markStuck after 10 min — reaper)

queued ──── cancelBatch ────► cancelled
```

Rank-ordered status (`STATUS_RANK`) — tracking webhooks can only advance, never regress.

**Stuck reaper**: `outbox.markStuck()` runs every 60s via `setInterval` in index.js (`.unref()`'d), marks queued rows older than 10 min as `failed/stuck`. Worker's existing `if (row.status !== 'queued') return` is the backstop if a worker picks up a reaped row.

## Templates

Mail rows carry a `template` string (mikser layout ID) + a `data` jsonb (per-recipient context). Worker renders:

```js
templates.renderText({ layout: row.template, ...row, ...(row.data || {}) })
```

`data` keys win over row columns. Single send and bulk send both support per-recipient `data`.

## Attachments

- Multer memory storage
- `attachments.saveBuffer(buffer, originalName)` → UUID filename → returns public URL
- `attachments.saveUrl(url)` → fetch + saveBuffer
- Storage: stringified URLs in `text[]` columns
- Served via `express.static(attachmentsFolder)` at `/mail/attachments/*`
- Unguessable UUIDs but no access control — anyone with a URL can fetch forever (known gap)

## Signature & auth

- `signature.verify()` — synchronous Mailgun HMAC + timestamp window check (default 5min). Context label (`Tracking`/`Inbound`) is logged on rejection.
- `requireAuth` — generic bearer token middleware from `core/auth.js`. Required on `/outbox`, `/bulk*`, `/suppressions*`, `/invalid*`.
- `/inbox` (form) is **public** — anyone can submit a contact form. Webhooks are public but signed.

## Notify topics

`mail.queued`, `mail.sent`, `mail.delivered`, `mail.opened`, `mail.engaged`, `mail.bounced`, `mail.complained`, `mail.failed`, `mail.received`, `mail.bulk.queued`, `mail.bulk.cancelled` — wired through `core/notify.js` which fans out to events bus + configured webhooks.

## Test coverage

```
outbox.test.js        14  create, track, failed, cancelBatch, markStuck
inbox.test.js          7  inboxMail (form path)
post.test.js           6  outboxMail HTTP — incl. data, idempotency, errors
bulk.test.js          16  send, dedupe, filter, cancel, HTTP
tracking.test.js      19  signature, event map, suppressions, invalid
suppressions.test.js  12  CRUD + HTTP
invalid.test.js       14  classifyMailerError + CRUD
                      ─────
                      88 tests
```

No test for: `mailer.js`, `attachments.js`, `signature.js`, `templates.js`, full worker integration (mocked everywhere).

## Known gaps

1. No attachment size/MIME limits — multer defaults; can OOM on huge uploads
2. No outbox `from` validation against allowed domains — anyone with auth can spoof
3. No orphan attachment GC — files accumulate forever
4. No worker integration test covering create→queue→worker→send
5. No `mailer.js` / `signature.js` tests
6. No Mailgun webhook event deduplication — same event can fire twice (outbox.track is idempotent by rank, but notify isn't)
7. No `List-Unsubscribe` header injection — relies on Mailgun's UI-side handling
8. No templates list/preview endpoint — can't introspect available mikser layouts

## Config shape

```js
config.mail = {
  attachmentsFolder: '/var/lib/whitebox/mail/attachments',
  company: 'info@example.com',
  mailgun: {
    apiKey, domain, webhookSigningKey,
  },
  webhookReplayWindowMs: 5 * 60 * 1000,
  webhooks: [ /* outbound notify webhook configs */ ],
  auth: { secret: '...' },
  outbox: {
    rate: { max: 10, duration: 60000 },
    attempts: 5,
    backoffMs: 5000,
    stuckThresholdMs: 10 * 60 * 1000,
    stuckCheckIntervalMs: 60 * 1000,
  },
}
```

## Design properties

- **Idempotency**: outbox.create dedupes by `idempotency_key`; BullMQ jobs use the same key as `jobId`; worker exits if row status isn't `queued`.
- **Atomicity**: state transitions are single UPDATEs; cancel/stuck/track all use `WHERE status = X` guards.
- **Notify everywhere**: every meaningful state change fires a notify event so external systems can subscribe.
- **Worker is the source of truth**: pre-checks happen worker-side, not HTTP-side, so bulk jobs and re-queues all get the same enforcement.
