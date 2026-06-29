# Instrumentation — wiring an external system for a clean analytics surface

How to feed WhiteBox so the analytics module ([analytics-concept.md](analytics-concept.md)) gives you cohorts, funnels, trends, retention, and grounded answers **without you modeling a taxonomy you don't own**.

WhiteBox stores customer data in **four primitives**, all hanging off one **passport** (the resolved person). Pick the right primitive for each thing you send and the query surface ([selector.md](selector.md)) lights up for free. Put data in the wrong one — or stuff dimensions into an opaque id — and you get nothing queryable. This doc is the decision guide + the wiring recipe.

> Core is a **library + MCP server**, not a REST-per-resource API. You "wire an external system" by writing (or configuring) an **integration** — a plugin that receives the source's webhooks/polls and translates them into the calls below. Integrations live in their own repos; the calls are the contract. The beauty-clinic seed (`server/scripts/seed-analytics.mjs`) is a complete worked example of every call here.

---

## 1. The four primitives at a glance

| Primitive | Table | What it is | Answers | Query as |
|---|---|---|---|---|
| **Identity** | `whitebox_passports` / `…_identities` | Who the person is (email, phone, user-id, fingerprint) — resolved & merged into one passport | "is this the same person?" | the spine — everything attaches to a passport |
| **Session / UTM** | `whitebox_sessions` | **Acquisition context** of a visit — how they arrived | "which campaign / source brought them?" | `metric.session:{utm_campaign}` · `group.by:"session:utm_campaign"` |
| **Event** (meta.event + attrs) | `whitebox_awareness_exposures` | **Something that happened** at a point in time — an action + its per-occurrence dimensions + text | "what did they do, when, how often?" — trends, funnels, counts | `metric.attrs:{event}` · `group.by:"attr:<key>"` |
| **Fact** | `whitebox_facts` | **Current/historical state** of the person — status, value, preferences | "who are they now?" — cohorts, segments, filters | `filter.fact:{key:{op}}` · `breakdownFact` · `scope` |

The one rule that makes all of this work: **a dimension lives in exactly one typed home.** Campaign is session UTM. An action is `meta.event`. Status is a fact. Never re-encode the same thing into a `content_id` slug (see [§8 Anti-patterns](#8-anti-patterns) and [event-attributes.md](event-attributes.md)).

---

## 2. Identity — the passport is the spine

Every other primitive takes a `passport_id`. Before you record anything, resolve the source's customer to a passport.

```js
// ctx.passports — given to every plugin
const id = await passports.identify(knownPassportId)     // resolves merges, creates one if none
await passports.link(id, [
  { type: 'email', value: 'yana@example.com', name: 'Yana Hristova' },
  { type: 'phone', value: '+359...' },
  { type: 'user',  value: 'crm-8841' },                  // your system's primary key
])
// or look one up:
const p = await passports.findByIdentity('email', 'yana@example.com')
```

- **Strong identities** (`email`, `phone`, `user`, `fingerprint`) are globally unique — one passport per value. Linking a strong identity that already belongs to another passport **merges** the two (within the type's lifespan: `email` 365d, `phone` 30d, `fingerprint` 7d). This is how an anonymous web visitor (fingerprint) becomes a known customer (email) and their history unifies — see [identity-merge.md](identity-merge.md).
- **Weak identities** are per-passport (a device id, an external anonymous id) — they never merge.
- Always link the **most stable id you have** (your CRM/user id), so re-runs and other integrations land on the same passport instead of forking.

> If you skip identity and invent a fresh passport per event, analytics still works numerically but every person is a stranger — no cohorts, no journeys, no merge from anonymous → known. **Resolve identity first.**

---

## 3. Session / UTM — acquisition context

A session is a **visit with where-from attribution**. Start one when someone arrives via a tracked link (signup page, ad landing, campaign click) and stamp the UTM params off the URL.

```js
const session = await sessions.start(id, {
  utm_source:   'newsletter',     // where (channel/publisher)
  utm_medium:   'email',          // how
  utm_campaign: 'spring_botox_2026',
  utm_term:     'botox',
  utm_content:  'hero-cta',
  referrer:     'https://google.com/...',
})
// session.id  → pass it on the events that happened in this visit (see §4)
await sessions.end(session.id)    // optional, on logout / session close
```

Use sessions **only for acquisition** — the standard UTM five, the way every ad/email tool already emits them. Don't put product events here. The payoff: "clients by campaign", "reach by source", campaign funnels — all join `whitebox_sessions` automatically when an event carries that `session_id`.

---

## 4. Events — `meta.event` + attributes (the activity stream)

An **event** is something that happened at a moment: an email opened, a booking made, a call placed, a page viewed. Record it with `awareness.record`. The shape that makes it queryable:

```js
await awareness.record({
  passport_id: id,
  channel:   'email',            // medium: email | sms | web | voip | crm …
  direction: 'outbound',         // outbound (you → them) | inbound (them → you)
  text:      'Spring botox promo — 20% off until April',  // human-readable content (→ semantic recall / embeddings)
  session_id: session.id,        // links to the session's UTM (optional but powerful)
  ts:        new Date(),
  meta: {
    event:     'email_open',     // ← THE ACTION (the verb). always set this.
    campaign:  'spring_botox_2026',  // ← per-event attributes (any keys you like)
    treatment: 'botox',
    value:     undefined,        // numeric attrs (e.g. amount) are summable — see below
  },
})
```

The convention is the whole point:

- **`meta.event` is the action** — a stable verb like `email_sent`, `email_open`, `email_click`, `sms_click`, `booking`, `call_outbound`. This is what funnels, trends, and "did they do X" filter on.
- **Other `meta.*` keys are per-occurrence attributes** — `treatment`, `device`, `campaign`, `value`, whatever dimensions that event carries. Each becomes a filter and a group dimension with **zero schema work** — the exposure row already stores `meta` jsonb; the query engine reaches into it ([event-attributes.md](event-attributes.md)).
- **`text` is the content** — a short human summary. It powers semantic recall and grounded answers ([scoped-recall.md](scoped-recall.md)); for purely structured events a one-line description is fine.
- **`channel` / `direction` / `source`** are first-class event columns (group/filter dimensions in their own right).
- **`content_id`** is optional and **opaque** — a message-id, URL, or call-id for dedup/trace. **Never** encode dimensions into it (that was the old mistake — [event-attributes.md §1](event-attributes.md)).

**Revenue:** put the amount in a numeric attribute (e.g. `meta.value`) and sum it: `metric:{ attrs:{event:'booking'}, sum:{field:'value'} }`.

---

## 5. Facts — the person's state

A **fact** is the *current (and historical) state* of the person — not an event, a property. `client_status`, `lifetime_value`, `preferred_treatment`, `membership`, `marketing_opt_in`, `next_appointment_at`.

```js
await facts.record({ passport_id: id, key: 'client_status',    value: 'active' })
await facts.record({ passport_id: id, key: 'lifetime_value',   value: 1820 })          // number
await facts.record({ passport_id: id, key: 'preferred_treatment', value: 'microneedling' })
await facts.record({ passport_id: id, key: 'marketing_opt_in', value: true })          // bool
await facts.record({ passport_id: id, key: 'last_treatment_at', value: '2026-03-14' }) // date
```

- **Append-only & bitemporal.** A value change is a *new row*; nothing is overwritten. The latest value wins for queries; the full history is queryable ("became lapsed in the last 30 days") — see [temporal-facts.md](temporal-facts.md). So just `record` the new value whenever it changes; don't read-modify-write.
- **Typed.** `number | bool | date | string`, inferred from the JS value (or pass `type`). Types matter: numeric facts power distribution/scatter and numeric range filters. (Store numbers as numbers, not `"1820"` strings.)
- **Latest value per key** is what `filter.fact` / `breakdownFact` / `scope` read.

---

## 6. Decision guide — fact vs event-attribute vs session-UTM

The single most common wiring mistake is putting a thing in the wrong primitive. Use this:

| Ask… | …it's a |
|---|---|
| Does it describe **how they arrived**? (campaign, source, medium) | **Session UTM** |
| Did **something happen at a point in time**? (opened, clicked, booked, called) | **Event** — `meta.event` = the verb |
| Is it a **dimension of that occurrence**? (which treatment this booking was, which device) | **Event attribute** — `meta.<key>` |
| Is it the person's **current/most-recent state**? (status, value, preference, membership) | **Fact** |
| Do you need a **running total / count of occurrences**? | derive from **Events** (count/sum), or snapshot into a **Fact** (`visits_count`, `lifetime_value`) if you query it as state a lot |

Worked distinctions:

- **"Botox"** is three different things depending on the question: the *treatment of a booking* → `meta.treatment` on the `booking` event; the *campaign that sold it* → `utm_campaign`; the *person's usual treatment* → fact `preferred_treatment`. Send each to its own home.
- **"Lapsed"** is a **fact** (`client_status='lapsed'`) — current state, used for cohorts/scope. The *act* of churning isn't an event; the win-back *call* is (`meta.event='call_outbound'`).
- **"Opened the email"** is an **event** (`meta.event='email_open'`), not a fact — you want it over time and in funnels, and a person opens many.

---

## 7. Wiring an external system, end to end

A realistic integration translates one source's webhooks into the calls above. Two examples (mirroring the seed):

**Email/SMS platform** — on each webhook:
```js
// 1. resolve identity from the recipient
const id = await passports.identify(await passports.findByIdentity('email', hook.email)?.id)
await passports.link(id, [{ type: 'email', value: hook.email }])

// 2. if it's an acquisition click off a campaign link, open a session with its UTMs
const session = hook.type === 'click'
  ? await sessions.start(id, pickUtms(hook.url))   // utm_* parsed from the link
  : await sessions.findActive(id)

// 3. record the action as an event
await awareness.record({
  passport_id: id, channel: 'email', direction: hook.type === 'open' ? 'inbound' : 'outbound',
  session_id: session?.id, text: hook.subject,
  meta: { event: `email_${hook.type}`, campaign: hook.campaign },   // email_sent | email_open | email_click
})

// 4. update marketing state as a fact (only when it changes)
if (hook.type === 'unsubscribe') await facts.record({ passport_id: id, key: 'marketing_opt_in', value: false })
```

**Booking / POS system** — on a completed booking:
```js
const id = await passports.identify((await passports.findByIdentity('user', booking.customerId))?.id)
await passports.link(id, [{ type: 'user', value: booking.customerId }, { type: 'phone', value: booking.phone }])

await awareness.record({
  passport_id: id, channel: 'web', direction: 'inbound', text: `Booked ${booking.treatment}`,
  meta: { event: 'booking', treatment: booking.treatment, value: booking.amount },   // value → summable revenue
})

// snapshot the new state as facts
await facts.record({ passport_id: id, key: 'client_status',     value: 'active' })
await facts.record({ passport_id: id, key: 'last_treatment',    value: booking.treatment })
await facts.record({ passport_id: id, key: 'last_treatment_at', value: booking.date })
await facts.record({ passport_id: id, key: 'lifetime_value',    value: customerLtvSoFar })   // a number
await facts.record({ passport_id: id, key: 'visits_count',      value: visitsSoFar })
```

That's it. No central schema migration, no taxonomy contract across integrations — each one just maps its events onto the four primitives.

---

## 8. What you get — the analytics surface

Because each primitive has a typed home, the selector ([selector.md](selector.md)) and the analytics module read them directly. From the data above, with no extra modeling:

- **Cohorts / segments / lists** ← facts: `filter:{ fact:{ client_status:{ eq:'lapsed' } } }`; split a cohort with `breakdownFact`; confine any aggregate to a cohort with `scope`.
- **Trends** ← events over time: `metric:{ attrs:{event:'email_open'}, count:{} }, group:{ by:'week' }`.
- **Breakdowns / donut / radar / pivot / heatmap** ← group by a dimension: `group.by:"attr:treatment"`, `"session:utm_campaign"`, `"channel"`, or `breakdownFact`.
- **Funnels** ← ordered `meta.event` steps: `email_sent → email_open → email_click → booking`.
- **Revenue** ← `sum:{field:'value'}` over the `booking` event.
- **Distribution / scatter** ← numeric facts: histogram of `lifetime_value`, `visits_count` vs `lifetime_value`.
- **Cohort retention** ← first-occurrence of an event per person, % active over later periods.
- **Compare (A vs B)** ← `splitBy` a fact's values (active vs lapsed) or named `series`.
- **Grounded answers** ← the `text` on events feeds scoped recall ([scoped-recall.md](scoped-recall.md)): "what are lapsed clients unhappy about, last 60d?"

Every one of those is a widget in the analytics console, and the same surface is exposed over REST + MCP (see [analytics-concept.md](analytics-concept.md)) so an agent can ask too.

---

## 9. Anti-patterns

- ❌ **Encoding dimensions in `content_id`** (`"campaign:spring:email:open"`) and substring-matching. That pushes a taxonomy onto you, is positionally fragile, and stores one dimension three ways. Use `meta.event` + attributes + session UTM instead ([event-attributes.md](event-attributes.md)).
- ❌ **Treating `content_id` as structured.** It's user-generated/opaque — a slug, message-id, or URL. Never query structure out of it.
- ❌ **Modeling an action as a fact** (`last_action='opened_email'`). You lose time-series, funnels, and counts. Actions are events.
- ❌ **Modeling state as a stream of events you re-aggregate every query** (recomputing `lifetime_value` from all bookings on read). Snapshot it into a fact.
- ❌ **Storing numbers as strings.** A numeric fact must be a number, or distribution/scatter/range filters mis-handle it.
- ❌ **Forking passports.** Not linking a stable identity → every event is a new stranger; no cohorts, no merge.
- ❌ **Re-encoding the same dimension in two primitives** (campaign as both a UTM and a fact). One typed home, or they drift.

---

## 10. Wiring checklist

For a "good analytics surface", an integration should:

- [ ] **Resolve identity first** — `findByIdentity` / `identify`, and `link` the most stable id you have (CRM/user id), plus email/phone when known.
- [ ] **Open a session with UTMs** on acquisition arrivals, and pass `session_id` onto that visit's events.
- [ ] **Record every action as an event** with `meta.event` = a stable verb and `channel`/`direction` set; add per-occurrence dimensions as `meta.*`; put amounts in a numeric attribute.
- [ ] **Give events a human `text`** so grounded answers work.
- [ ] **Snapshot state as typed facts** whenever it changes (status, value, preferences, dates) — numbers as numbers.
- [ ] **Keep `content_id` opaque** — trace/dedup only, never a query axis.

Get those six right and the whole analytics module — cohorts, trends, funnels, breakdowns, distributions, retention, compare, and grounded answers — works with no further modeling.

---

**See also:** [analytics-concept.md](analytics-concept.md) (the console & query def) · [selector.md](selector.md) (the query engine) · [event-attributes.md](event-attributes.md) (why `meta` over `content_id`) · [temporal-facts.md](temporal-facts.md) (fact history) · [identity-merge.md](identity-merge.md) (anonymous → known) · [scoped-recall.md](scoped-recall.md) (grounded answers).
