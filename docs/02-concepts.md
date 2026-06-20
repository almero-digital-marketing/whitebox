# 02 · Concepts

The things to understand before anything else: **passport**, **session**, the two
memories — **awareness** (semantic) and **facts** (structured) — **direction**, the
**selector** (one query over both memories), and the **context registry**.

## Passports & identity

A **passport** is one person. It has a UUID and a set of **identities** attached
to it. An identity is a triple:

```
{ type: 'email', name: 'primary', value: 'ada@example.com' }
{ type: 'phone', name: 'e164',    value: '+359888123456' }
{ type: 'fingerprint', name: 'browser', value: 'a1b2c3…' }
{ type: 'user',  name: 'app',     value: 'user_42' }
```

**Strong identities** (`fingerprint`, `phone`, `email`, `user`) are globally
unique — one passport per value. **Weak identities** (any other `type`, e.g. a CRM
contact id) are unique only within a passport.

### Merging

When a strong identity is linked to a passport but already belongs to another
(still within its lifespan), the two passports **merge**: one absorbs the other,
all references repoint to the survivor, and the absorbed id is kept as a tombstone
so future lookups forward to the survivor. This is how a person who first arrived
as an anonymous browser fingerprint, then gave an email, then called from a phone,
ends up as **one** customer with one memory.

Identity **lifespans** (how long an identity stays "fresh" enough to trigger a
merge) are configurable per type — defaults: `fingerprint` 7 days, `phone` 30,
`email` 365, `user` forever. See [Configuration](04-configuration.md).

You rarely link identities by hand — channels do it for you (a mail send links the
recipient's email; an inbound SMS links the sender's phone; the browser SDK links
the fingerprint). The CRM plugin links from your external customer ids.

## Sessions

A **session** is a time-boxed visit attached to a passport, carrying `utm_source`,
`utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, and `referrer`. The
browser SDK opens one at page load via `POST /sessions/resolve`, which mints a
passport if needed and returns `{ passportId, sessionId }`. Awareness records can
reference the session, so you can attribute a later conversion back to the
campaign that started the visit.

## Awareness

**Awareness** is the per-passport semantic memory. Every meaningful touch is one
`record(...)` call (channels do this for you):

```js
awareness.record({
  passport_id,          // who (merged passports auto-resolve to the survivor)
  session_id,           // optional, for attribution
  ts,                   // when (defaults to now)
  channel: 'mail',      // mail | sms | web | voip | crm | …
  direction: 'exposure',// see below
  source: 'email',      // sub-type within the channel
  content_id: 'outbox:42', // stable id → repeated webhooks dedupe
  text: 'Subject: …',   // the actual content (PII-redacted by default)
  meta: { … },          // channel-specific extras
})
```

What happens to it:

- The `text` is **PII-redacted** (configurable), then hashed (`content_hash`).
- An **exposure** row is written immediately.
- A background worker splits the text into **chunks** (~200 words) and embeds each
  with OpenAI (`text-embedding-3-small`, 1536-dim). Identical content is embedded
  **once** and shared across every customer who saw it.
- Chunks are vector-indexed (HNSW) for fast semantic recall.

So "record" is cheap and synchronous; embedding is async and deduplicated.

## Facts — the structured memory

Awareness is unstructured memory (text → embeddings → fuzzy recall). **Facts** is
its **structured twin**: an append-only, typed, per-passport timeline of exact
attributes — `plan_tier`, `mrr`, `subscription_status`, `renewal_date`, and the
like. Where awareness answers "what has this person seen / said," facts answers
"what is true about this person, and what *was* true."

```
awareness  =  append-only SEMANTIC   memory   (ts,          text → embedded)         → fuzzy
facts      =  append-only STRUCTURED memory   (observed_at, key, value:type)         → exact
```

A **fact** is one observation of one attribute at one time, written through the
core `ctx.facts` primitive — the structured counterpart of `awareness.record()`:

```js
ctx.facts.record({
  passport_id,             // who
  key: 'plan_tier',        // the attribute
  value: 'pro',            // typed: "pro" | 240 | true | "2026-07-01"
  type: 'string',          // 'string' | 'number' | 'bool' | 'date'
  source: 'stripe',        // where it came from — no source is privileged
  observed_at: '2026-04-10',// VALID time: when this value became true
  entity: 'subscription:sub_123', // optional link to an external entity
})
```

Nothing is ever overwritten — a value change is a **new row**. So **current** =
the latest value per key, and **as of D** = the value whose validity window
contains `D` (`max(observed_at ≤ D)`). That makes two things honest that a
latest-only store can't do: querying on a fact's *value* (not just its presence),
and **time travel** — "was this customer Pro on Black Friday," "downgraded in the
last 30 days." History also unlocks *transition* predicates (`changed`,
`transition`, `decreased`, `increased`).

Sources write facts; no source *owns* them. The CRM plugin is just the most common
source — it ingests external records and turns each scalar into a `ctx.facts`
call (see [the context registry](#the-context-registry) below).

## Direction — the most important field

`direction` captures **who acted and how strong the signal is**. It's the axis you
filter and reason over.

| direction | meaning | examples |
|---|---|---|
| `exposure` | We put content in front of them (passive receipt) | a sent email, an SMS, an article paragraph they read, an email **open** |
| `expression` | *They* acted (active signal) | an inbound reply, a form submission, a link/CTA click, an SMS `STOP`/`START` |
| `conversation` | Two-way live interaction | a voice call transcript |
| `conversion` | A business outcome | purchase, lead, add-to-cart |
| `observation` | A fact recorded about them, no interaction | a CRM note, an imported tag, a client-reported UI event |

Paired with `channel` and `source`, this lets you ask precise questions — *"what
have we told this customer about pricing"* (exposure) vs *"what has this customer
told us"* (expression).

> Note: email **opens** are recorded as `exposure` (they were exposed to the body),
> while a **click** is an `expression`. The send itself records only the subject as
> exposure; the body enters memory when they actually open it.

## Channels

A **channel** is a class of touchpoint — `mail`, `sms`, `web`, `voip`, `crm`. Each
is implemented by a plugin that owns its HTTP endpoints, its background work, and
the awareness it writes. Plugins are independent: they communicate only through the
shared `ctx` (database, queue, events, passports, awareness, …), never by importing
one another. See [07 · Channels](07-channels.md).

## The selector — one query over both memories

The two memories are queried through one shape: a **selector**.

```js
selector = { about?, filter?, judge? }   // all three optional
```

- **`about`** — a semantic topic (vector over awareness). Ranks evidence
  (knowledge) or gates people (a similarity floor).
- **`filter`** — a boolean tree (`all` / `any` / `not`) of deterministic clauses:
  `fact` (a typed value/temporal gate over the **facts** timeline) and `metric`
  (a windowed aggregate over the **awareness** event stream).
- **`judge`** — an optional LLM membership predicate, for nuance the other two
  can't express. It decides *who's in*; it never writes prose.

A selector **resolves** to a projection — **people** (a cohort) or **knowledge**
(ranked evidence) — and `asOf` time-travels both memories together. This is the
**core QUERY surface**: analytics and audiences both speak this one predicate
rather than two filter languages. The querying chapter covers it in full —
[05 · Awareness & querying](05-awareness-and-querying.md).

## The context registry

Awareness is unstructured memory (text); the structured side of a person now lives
in the **[facts](#facts--the-structured-memory)** memory. The **context registry**
is the seam that surfaces structured state to the `/analytics/ask` layer: a plugin
registers a provider that returns typed facts about a passport (e.g. `plan_tier`,
`mrr`, subscription status — the CRM provider surfaces `facts.current`). When you
`ask` a question about a customer, WhiteBox assembles both — recalled awareness
chunks **and** registered context — and grounds the LLM's answer in them.

> Structured CRM state is no longer the CRM plugin's private store — it's written
> into the core **facts** memory (`ctx.facts`), so the selector's `filter.fact`
> clauses read the same truth the context provider surfaces.

Next: **[03 · Getting started](03-getting-started.md)**.
