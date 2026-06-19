# Whitebox

A unified backend for customer-facing communication channels — **mail**, **voip**, and **web** — that captures everything into a per-passport semantic memory, queryable in natural language.

Whitebox handles the **handshake**: sending outbound messages, receiving inbound ones, transcribing calls, fetching content. The company keeps using their own email client and phone for actual conversations. Whitebox stays out of the way but remembers everything.

## Project status: pre-1.0, breaking changes welcome

Whitebox is actively being shaped. **Backwards compatibility is not a design constraint at this stage.** Schemas, config keys, plugin APIs, table layouts, HTTP routes, and protocol choices change whenever a cleaner design appears. We don't carry deprecated paths, dual-mode flags, or migration shims unless there's a concrete operator (not "a hypothetical future user") who needs them.

The practical implication: when reading any commit or design discussion, the question is *"is this the right shape?"* — not *"does this preserve the previous shape?"*. If a feature lands and then a better way of doing it shows up, the old way gets deleted, not deprecated. README and tests get rewritten to match; no `@deprecated` markers, no `legacy: true` config branches.

This will change at some point — once whitebox is running in real deployments we don't control, the rules flip. Until then, we optimise for *clarity of the current design*, not for the cost of the migration that got us here.

## What makes this different

Most analytics tools track **what users did** — clicks, page views, durations. Whitebox tracks **what users have been exposed to and what they've expressed**, across every channel, as semantic content. That unlocks a different class of question.

### Example questions whitebox can answer

#### Cohort awareness — *"who knows about X?"*

> How many users have been exposed to our spring promotion in the last 14 days?

> How many users on the pricing page actually read the Enterprise tier section vs. just scrolled past?

> Of users who signed up last week, how many had seen our security/compliance content before signing up?

> How many users have watched the part of the demo video where we show the Salesforce integration?

> Which leads were exposed to our case study about retail, vs. the one about manufacturing?

> How many of our trial users have read the API documentation page?

#### Per-user awareness — *"what does this user know?"*

> Before this support call, what content has the customer consumed? Don't make them re-watch the intro.

> When sending a sales follow-up, what's this prospect already familiar with?

> Has this user been exposed to our refund policy? *(useful before a billing dispute)*

> What did this passport read on the pricing page that's making them ask about discounts?

> Did this user actually see the upgrade prompt, or did they miss it?

#### Pre-conversion awareness — *"what predicts signup?"*

> What content do users who convert have in common that non-converters don't?

> Among trial users who became paying customers, what was the last piece of content they saw before signing up?

> How many users sign up after watching at least 60% of the product demo?

> Of users who saw both our case study AND our pricing page, what's the conversion rate vs. those who only saw pricing?

#### Content effectiveness — *"what's working?"*

> Which sections on our homepage get the most semantic engagement — people actually reading the meaning, not just dwell time?

> Are users who watch the founder video more likely to mention "mission" or "values" on the contact form?

> Which images do users dwell on longest — are they understanding what they show?

> Is our messaging about "enterprise security" actually reaching the users who later ask about it?

#### Gap analysis — *"what don't users know?"*

> Among users who ask about feature X in chat, how many had been on the feature X page? *(if high, the page isn't doing its job)*

> Of users who churned this quarter, what content did they NOT see that retained users did?

> How many users who contacted support about pricing had never visited the pricing page?

> Find topics that come up in customer questions but aren't covered anywhere in the content.

#### Sales / support hand-off — *"what's the context?"*

> Generate a one-paragraph summary of what this user has been exposed to about our product, suitable for an AE briefing.

> When this support ticket came in, what was the user looking at in the last hour?

> For this incoming voip call, what's the caller's most recent content trail?

> Has this lead seen our pricing? If yes, which tier did they spend the most time on?

#### Campaign measurement — *"did the audience get the message?"*

> How many users exposed to the spring promo banner actually consumed the message (not just glanced past)?

> Of users who clicked the email link to our integrations page, how many actually read about the specific integration they came for?

> Did the homepage redesign change which sections users actually process meaningfully?

> Among users who attended the webinar (or watched the recording), how many read the follow-up article we promoted?

#### Cross-channel — *"is the message consistent?"*

> Users who saw our ad about "fast deployment" — when they landed on the site, did they read content matching that promise?

> Are users coming from the LinkedIn campaign consuming different content than users from Google search?

> Did the message in our email campaign actually reach users — were the same concepts present in their on-site content trail?

#### Temporal questions — *"when did awareness happen?"*

> When did this user first learn we offer SSO?

> How long does it typically take from first visit to consuming our pricing content?

> Among users who converted, what's the average time between first content exposure and signup?

> Find users who saw our 'free trial' messaging more than 30 days ago and never came back.

#### Regulatory / disclosure — *"did they actually see the notice?"*

> Did this user see the terms of service before signing up?

> Did the user read the updated privacy disclosure, given that we changed it on Feb 1?

> Find users who consumed the old privacy policy but haven't seen the updated one.

#### Diagnostic — *"why is this happening?"*

> Why is this user asking about feature X? Trace their content trail.

> This support ticket says "I didn't know X" — verify whether they actually saw content about X.

> Show me the content trail of the last 10 users who signed up — is there a common pattern?

## How it works

Three channel plugins feed one core memory:

```
┌────────────┐   ┌────────────┐   ┌────────────┐
│ engagement │   │    mail    │   │    voip    │
│  (web)     │   │ (email)    │   │ (phone)    │
└─────┬──────┘   └─────┬──────┘   └─────┬──────┘
      │                │                │
      │  section text  │  email bodies  │  call transcripts
      │  video frames  │  inbound forms │  + Whisper audio
      │  image desc    │  outbound mail │
      │                │                │
      └────────────────┼────────────────┘
                       ▼
                ┌──────────────┐
                │  awareness   │  ← core: text + metadata, no domain knowledge
                │   (core)     │     pgvector embeddings, semantic search
                └──────┬───────┘
                       │
                ┌──────▼───────┐
                │  analytics   │  ← read API
                └──────────────┘
```

- **engagement** — receives web events via Socket.IO from the browser. Resolves video URLs to transcripts (Whisper + frame Vision), image URLs to descriptions (Vision after sharp resize), section text inline. Caches by URL.
- **mail** — sends/receives email via Mailgun. Emits outbound mail as exposure events, inbound mail as expression events.
- **voip** — observes Asterisk via AMI. Records, transcribes (Whisper + GPT normalization), emits as conversation events.
- **awareness** — chunks, embeds, stores. Exposes `recall` / `population` / `timeline` / `forget`. No HTTP surface — only modules call into it.
- **analytics** — thin HTTP layer over awareness queries. Auth-protected.

Each channel plugin owns its own domain (multer/multipart for mail, AMI events for voip, ffmpeg/sharp for engagement). Awareness only sees text + tags.

## Module documentation

- [`src/plugins/mail/README.md`](src/plugins/mail/README.md) — outbox, inbox, bulk, suppression/invalid lists, tracking webhooks
- [`src/plugins/voip/README.md`](src/plugins/voip/README.md) — PBX observation, number pool, call recording, Whisper transcription

## Quick start

```bash
# Postgres (with pgvector extension), Redis required
createdb whitebox
psql whitebox -c "CREATE EXTENSION IF NOT EXISTS vector"

npm install
cp whitebox.config.example.js whitebox.config.js
# edit whitebox.config.js with your DB/Redis/Mailgun/OpenAI keys

npm run dev
```

## Configuration

```js
export default {
  port: 3000,
  plugins: ['mail', 'voip', 'engagement', 'analytics'],

  db: { /* knex connection */ },
  redis: { host, port, password },
  openai: { apiKey: '...' },

  passports: { lifespans: { fingerprint: 7, phone: 30, email: 365, user: Infinity } },

  awareness: {
    enabled: true,
    pii: { redact: true },
    embedding: { model: 'text-embedding-3-small' },
    chunk: { size: 200 },
    webhooks: { recorded: { /* subscribe to awareness.recorded */ } },
  },

  engagement: {
    image: { maxSide: 1024, quality: 85, detail: 'low' },
    video: { extractVisual: true, framePeriodSec: 5, sceneThreshold: 0.3 },
    auth: { secret: '...' },
  },

  analytics: { auth: { secret: '...' } },

  mail: { /* see plugin README */ },
  voip: { /* see plugin README */ },
}
```

## Core capabilities (built-in, not plugins)

- **passports** — identity resolution and merging across channels
- **sessions** — per-visit context with UTM/referrer
- **awareness** — per-passport semantic memory (described above)
- **connect** — Socket.IO bridge to browser clients
- **queue** — BullMQ wrapper
- **events** — internal pub/sub
- **webhooks** — outbound notify dispatch
- **scheduler** — recurring background tasks
- **templates** — mikser-io REST wrapper for email rendering
- **auth** — bearer token middleware

## Architecture properties

- **Plugin-based** — channels (`mail`/`voip`/`engagement`/`analytics`) are independent plugins with their own migrations, registered via `config.plugins`
- **Idempotent everywhere** — outbox dedupes by idempotency key, awareness exposures have stable content_ids, BullMQ jobs use predictable IDs
- **Worker-first** — heavy work (sending mail, embedding text, transcribing audio) goes through BullMQ; HTTP handlers are thin
- **Notify on every state change** — `mail.sent`, `voip.call`, `awareness.recorded`, etc. fan out to internal subscribers + configured webhooks
- **Consent-aware** — `awareness.enabled = false` no-ops the entire memory layer for compliance-restricted deployments

## Privacy considerations

The semantic memory is a **personal exposure profile**. Whitebox includes:

- **PII redaction** at ingest (CC, SSN, IBAN patterns) — extensible
- **`awareness.forget(passport_id)`** for GDPR delete — cascades to embeddings
- **Per-passport timeline endpoint** for data inspection / right-to-access
- **Per-deployment opt-out** via `config.awareness.enabled = false`

Call recording, email retention, and content profiling are jurisdictionally complex. Don't deploy awareness without aligning with your legal/compliance posture.

## Tests

```bash
npm test
```

Current coverage: 128 tests across mail, voip core paths, passports, sessions. Engagement, analytics, and awareness modules don't have tests yet — that's the next pass.

## Status

v2 is the current development line. Production-readiness varies by module — mail and voip are battle-tested; engagement and awareness are new and need integration testing.
