# Mail Plugin

> Transactional, marketing, and contact-form email — sent, tracked, suppression-managed, and fed into the per-passport semantic memory so every message becomes part of `/analytics/ask` evidence.

## What it is

The email **handshake** for whitebox: outbound sending (transactional + bulk), inbound capture (contact forms and email replies), tracking-webhook ingestion, and the two block lists every production sender needs (unsubscribed / hard-bounced).

The **email service provider is pluggable** — this plugin owns the outbox/queue/suppressions/awareness plumbing, and a composed provider package owns the transport, webhook authenticity, and payload shapes. `whitebox-mail-mailgun` and `whitebox-mail-postmark` (each its own external repo) ship today; adding another is a new package implementing the same small contract, not a change here.

It's not a thread tracker. The company's real email client owns multi-turn conversations — this plugin captures the *first* and *last* hop of each touch (we sent X, they replied Y) and routes anything in between as a forward to a designated company inbox. The point isn't to replace the inbox, it's to make the messages part of the customer's awareness profile.

## What you get

- **One outbound API for everything.** `POST /mail/outbox` (single) and `POST /mail/bulk` (up to 10k recipients) share the same template engine, per-recipient `data`, suppression checks, idempotency, and retry semantics.
- **Public contact-form intake.** `POST /mail/inbox` accepts multipart form posts (no auth, signature-verified or rate-gated at your proxy), saves attachments, forwards to the company inbox, and links the submitter to a passport — with strong/weak identities pulled from form fields (email, phone, name, address, URLs). It is inbound-only: it never sends mail back to the submitter. For an acknowledgment auto-reply, subscribe to the `mail.received` event and send via `POST /mail/outbox`.
- **Provider delivery + reply webhooks.** Authenticity-verified inbound (`POST /mail/webhooks/inbox`) and tracking (`POST /mail/webhooks/tracking`) routes turn delivered/opened/clicked/bounced into a rank-ordered status machine you can subscribe to via notify events. The provider normalizes its own event names into one canonical vocabulary.
- **Two block lists, two reasons.** `suppressions` (user opt-out, reversible) and `invalid` (technical undeliverability, permanent) — both auto-populated from webhooks and exposed as CRUD endpoints.
- **Messages become memory.** Every send and every inbound is fed to `core/awareness` with channel `mail`, so `/analytics/ask` can later answer *"have we told this customer about the refund policy?"* and cite the exact email.
- **Identity gravity.** Form submissions attach phone/name/address/URL identities to the sender's passport (deduped, libphonenumber-validated, no body-text scraping). Subsequent calls from the same phone or visits with the same email merge automatically.
- **Stuck-row reaper.** Outbox jobs that never resolved after 10 minutes are marked failed so workers can't accidentally double-send on restart.

## How to integrate

### 1. Enable the plugin

```js
import { mail } from 'whitebox-server-plugin-mail'
import { mailgun } from 'whitebox-mail-mailgun'   // or: import { postmark } from 'whitebox-mail-postmark'

plugins: [
  mail({
    attachmentsFolder: '/var/lib/whitebox/mail/attachments',
    company: 'info@example.com',                  // forward target for /mail/inbox
    // The provider is composed like a plugin and owns transport + webhook auth.
    provider: mailgun({
      apiKey: process.env.WB_MAILGUN_API_KEY,
      domain: 'mail.example.com',
      webhookSigningKey: process.env.WB_MAILGUN_WEBHOOK_SIGNING_KEY,
    }),
    auth: { secret: process.env.WB_MAIL_TOKEN },
  }),
]
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

### 5. Wire the provider webhooks

Point your provider's *Inbound* and *Tracking* (delivery/open/click/bounce/complaint) webhooks at:

```
POST https://wb.example.com/mail/webhooks/inbox
POST https://wb.example.com/mail/webhooks/tracking
```

No app-level bearer auth — the composed provider verifies each request's authenticity (Mailgun signs with HMAC + replay window; Postmark uses HTTP Basic auth on the webhook URL — see the provider package's README). Bounces and complaints automatically populate the respective block lists.

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
├── index.js          - Plugin entry; validates + wires the provider, mounts routes
├── outbox.js         - Send queue, worker, HTTP /outbox, batch ops
├── inbox.js          - Form submissions + provider inbound webhook (provider.parseInbound)
├── bulk.js           - Bulk send with per-recipient data
├── tracking.js       - Provider tracking webhook → canonical event → status machine
├── mailer.js         - Resolves attachments + delegates send to the provider
├── attachments.js    - UUID-named file storage
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
    ├── 012 outbox_cancelled
    └── 013 outbox_provider_message_id  (renames mailgun_id → provider_message_id)
```

The provider-specific code (transport, webhook signature, payload parsing) lives **outside** this package — in the external `whitebox-mail-mailgun` / `whitebox-mail-postmark` repos — each implementing: `send(msg)→{messageId}`, `verifySignature(req, kind)`, `parseInbound(req)`, `parseTracking(req)`, and optionally `ownsAddress` / `classifyError`.

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
  ↓ mailer.send → provider.send
      ↳ permanent error (provider.classifyError) → invalid.add + fail terminal (no retry)
      ↳ transient → throw → BullMQ retry with exponential backoff
  ↓ outbox.sent() — store provider_message_id, mark sent
  ↓ notify mail.sent
```

### Bulk send

```
POST /mail/bulk (auth)
  ↓ Zod validate (max 10k recipients)
  ↓ dedupe by normalized email
  ↓ checkMany() against suppressions + invalid — one query each
  ↓ saveUrl() attachments once for the whole batch
  ↓ outbox.createMany() — single INSERT (one row per recipient)
  ↓ enqueue:
      provider has sendBatch() → chunk jobs of ≤ provider.maxBatchSize
                                 (one provider call per chunk)
      otherwise               → one job per row (fan-out)
  ↓ notify mail.bulk.queued
  ← 202 { batch_id, accepted, skipped_*, duplicates }

GET /mail/bulk/:batchId            → status counts (GROUP BY status)
POST /mail/bulk/:batchId/cancel    → cancel queued rows in batch
```

**Native provider batch.** The row-per-recipient model is unchanged (so cancel,
stats, awareness, and suppression all still work per recipient); only the *send*
is batched. The worker drains a chunk and makes one `provider.sendBatch(messages)`
call:

- **Postmark** — `sendEmailBatch` (≤500), each message independently rendered, a
  `MessageID` per recipient → per-recipient tracking is direct.
- **Mailgun** — when the chunk's rendered body is uniform, one `recipient-variables`
  call (≤1000) that returns no per-recipient ids; the tracking handler then
  matches the first webhook per recipient by email (scoped to batched rows) and
  backfills `provider_message_id`. Personalized (differently-rendered) chunks fall
  back to concurrent individual sends, which return real per-recipient ids.

A provider without `sendBatch` keeps the original one-job-per-recipient fan-out.
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

### Inbound — provider webhook (replies, ad-hoc)

```
POST /mail/webhooks/inbox (multer.any())
  ↓ provider.verifySignature(req, 'inbound')
  ↓ provider.parseInbound(req) → { from, to, subject, body, bodyHtml, attachments[] }
  ↓ saveBuffer() any attachments
  ↓ identify/link sender passport
  ↓ insert inbox row (source='inbound')
  ↓ notify mail.received
  ← 200
```

No forward — the provider's inbound routing handles that.

### Tracking webhook

```
POST /mail/webhooks/tracking (no bearer — provider-verified)
  ↓ provider.verifySignature(req, 'tracking')
  ↓ provider.parseTracking(req) → { messageId, event, recipient, severity, errorMessage }
      (provider normalizes its event names → canonical: delivered/opened/clicked/bounced/complained/unsubscribed)
  ↓ status map: delivered/opened/clicked→engaged/bounced/complained
  ↓ outbox.track() — advances status only if higher rank (no regression)
  ↓ notify mail.<status>
  ↓ classify side-effects:
      unsubscribed/complained → suppressions.add
      bounced + severity=permanent → invalid.add
```

## The two block lists

| List | Source | Reversible | Meaning |
|---|---|---|---|
| `suppressions` | unsubscribed/complained webhooks + manual API | yes (re-subscribe) | user intent — "I shouldn't send" |
| `invalid` | hard bounces + permanent send errors + manual | no | technical — "I can't send" |

Both are checked in the outbox worker's `preflightBlock()`. Both expose CRUD APIs at `/mail/suppressions` and `/mail/invalid`.

`provider.classifyError(err)` (with `invalid.classifyMailerError` as the built-in fallback) decides if a send error is permanent. Permanent → block address forever; transient → retry.

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

- `provider.verifySignature(req, kind)` — webhook authenticity, owned by the composed provider (Mailgun HMAC + replay window; Postmark HTTP Basic auth). `kind` is `'inbound'` or `'tracking'`.
- `requireAuth` — generic bearer token middleware from `core/auth.js`. Required on `/outbox`, `/bulk*`, `/suppressions*`, `/invalid*`.
- `/inbox` (form) is **public** — anyone can submit a contact form. Webhooks are public but provider-verified.

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

The plugin tests inject a fake provider, so they cover the plumbing regardless of provider. Each provider package (`whitebox-mail-mailgun`, `whitebox-mail-postmark`) ships its own tests for send/verify/parse. No test here for: `mailer.js`, `attachments.js`, `templates.js`, full worker integration (mocked everywhere).

## Known gaps

1. No attachment size/MIME limits — multer defaults; can OOM on huge uploads
2. No outbox `from` validation against allowed domains — anyone with auth can spoof
3. No orphan attachment GC — files accumulate forever
4. No worker integration test covering create→queue→worker→send
5. No `mailer.js` test (the provider packages test send themselves)
6. No provider webhook event deduplication — same event can fire twice (outbox.track is idempotent by rank, but notify isn't)
7. No `List-Unsubscribe` header injection — relies on the provider's UI-side handling
8. No templates list/preview endpoint — can't introspect available mikser layouts

## Config shape

```js
mail({
  attachmentsFolder: '/var/lib/whitebox/mail/attachments',
  company: 'info@example.com',
  provider: mailgun({ apiKey, domain, webhookSigningKey, replayWindowMs: 5 * 60 * 1000 }),
  // …or postmark({ serverToken, from, webhookUser, webhookPassword })
  webhooks: [ /* outbound notify webhook configs */ ],
  auth: { secret: '...' },
  outbox: {
    rate: { max: 10, duration: 60000 },
    attempts: 5,
    backoffMs: 5000,
    stuckThresholdMs: 10 * 60 * 1000,
    stuckCheckIntervalMs: 60 * 1000,
  },
})
```

## Design properties

- **Idempotency**: outbox.create dedupes by `idempotency_key`; BullMQ jobs use the same key as `jobId`; worker exits if row status isn't `queued`.
- **Atomicity**: state transitions are single UPDATEs; cancel/stuck/track all use `WHERE status = X` guards.
- **Notify everywhere**: every meaningful state change fires a notify event so external systems can subscribe.
- **Worker is the source of truth**: pre-checks happen worker-side, not HTTP-side, so bulk jobs and re-queues all get the same enforcement.
