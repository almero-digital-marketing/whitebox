# 07 · Channels

Each channel is a plugin you enable in `config.plugins`. This is a usage-level tour
— purpose, how to wire it, its main endpoints, and what it writes to awareness.
Every channel has a deeper README in its own package; links are at the end of each
section.

> Endpoint paths are shown relative to the plugin's mount. "Bearer" = the plugin's
> own `WB_*_TOKEN`. Browser-facing ingress and provider webhooks are not bearer-auth.

---

## Mail

Transactional + bulk email, inbound replies and contact-form submissions, open/click
tracking, bounce/complaint suppression — over a **pluggable provider** (Mailgun or
Postmark today).

```js
mail({
  company: 'team@example.com',        // where inbound + form submissions forward
  provider: mailgun({ apiKey, domain, webhookSigningKey }),
  auth: { secret: process.env.WB_MAIL_TOKEN },
  outbox: { rate: { max: 10, duration: 60000 }, attempts: 5, backoffMs: 5000 },
})
```

| endpoint | auth | purpose |
|---|---|---|
| `POST /mail/outbox` | Bearer | send one (templated or raw) |
| `POST /mail/bulk` | Bearer | batch send (native provider batch where supported) |
| `POST /mail/inbox` | Bearer | submit a contact-form message |
| `POST /mail/webhooks/inbox` · `…/tracking` | provider-signed | inbound replies, delivery/open/click |
| CRUD `/mail/suppressions` · `/mail/invalid` | Bearer | block lists |

**Awareness:** send → `exposure` (subject only); open → `exposure` (subject+body);
click → `expression`; inbound reply / form → `expression`.

**Extras:** native batch send, **UTM-aware personalized short links** (mark a link
with `data-wb-shorten` and it becomes a per-recipient shortener link). MCP:
`mail.send`, `mail.outbox_get`, `mail.inbox_list`, `mail.suppress`/`unsuppress`.

→ [`whitebox-pro-server-plugin-mail`](../server-plugin-mail) ·
providers: [mailgun](08-integrations.md), [postmark](08-integrations.md).

---

## SMS

The SMS counterpart to mail: send (single + bulk), inbound replies with
**STOP/START** opt-out, delivery-status (DLR) tracking, suppression/invalid lists —
with the **provider chosen per destination**.

```js
sms({
  provider: twilio({ accountSid, authToken, from }),     // default / international
  routes: { '+359': mobica({ user, pass, from: 'Brand' }) },  // BG → Mobica
  defaultCountry: 'BG',
  auth: { secret: process.env.WB_SMS_TOKEN },
})
```

| endpoint | auth | purpose |
|---|---|---|
| `POST /sms/outbox` | Bearer | send one |
| `POST /sms/bulk` (+ `/bulk/:id`, `/bulk/:id/cancel`) | Bearer | batch + stats + cancel |
| `POST/GET /sms/webhooks/:provider/inbound` · `…/status` | provider-verified | inbound (MO) + DLR |
| CRUD `/sms/suppressions` · `/sms/invalid` | Bearer | block lists |

**Routing:** longest E.164 prefix match picks the provider; each provider's webhooks
live under `/sms/webhooks/:provider/*`. **Compliance:** inbound `STOP`/`UNSUBSCRIBE`
suppresses; `START` un-suppresses. **Awareness:** send → `exposure`, inbound →
`expression`. MCP: `sms.send`, `sms.outbox_get`, `sms.inbox_list`,
`sms.suppress`/`unsuppress`.

→ [`whitebox-pro-server-plugin-sms`](../server-plugin-sms) · providers:
twilio, mobica (incl. multi-instance DLR fan-out).

---

## Engagement

Fine-grained web behaviour — text reading, image dwell, video watch intervals, link
clicks — captured by the browser SDK and fed into awareness with depth metrics.
Video transcripts (Whisper) and image descriptions (Vision) are generated and cached.

```js
engagement({
  auth: { secret: process.env.WB_ENGAGEMENT_TOKEN },
  image: { detail: 'low' }, video: { visionDetail: 'low' },
})
```

| endpoint | auth | purpose |
|---|---|---|
| `POST /engagement/events` | none (browser) | batched events (sendBeacon fallback) |
| `GET/DELETE /engagement/content[/:url]` | Bearer | inspect / invalidate cached transcripts & descriptions |

**Awareness:** channel `web`. Text/section/image/video → `exposure` (engagement-
weighted by how much they actually read/watched); link click → `expression`. The
client plugin instruments the page automatically (`data-wb-text`, `data-wb-image`,
videos, `a[href]`). MCP: `engagement.list_content`, `get_content`,
`invalidate_content`.

→ [`whitebox-pro-server-plugin-engagement`](../server-plugin-engagement)
· client: `whitebox-pro-client-plugin-engagement`.

---

## CRM

A **thin facts adapter** — it owns no store of its own. Ingest customer state from
external systems (Salesforce, Stripe, Zendesk, …) as **records** (structured:
subscriptions, deals, tickets) that write into the **core facts** memory
(`ctx.facts`), and **notes** (free-form: notes, tags, call summaries) that flow into
awareness as observations. A record's `status` becomes a fact keyed by `kind`, each
scalar in `data` its own fact — so state is queryable through the selector's
`filter.fact` (audiences/analytics never go through a CRM-specific path).

```js
crm({ auth: { secret: process.env.WB_CRM_TOKEN } })
```

| endpoint | auth | purpose |
|---|---|---|
| `POST /crm/records` | Bearer | upsert structured state → core facts (status → fact keyed by `kind`, each `data` scalar → its own fact) |
| `POST /crm/facts` | Bearer | add free-text notes → awareness (`observation`) |
| `GET /crm/records/:passport_id` | Bearer | a passport's **current facts** as `{ data: { key: value, … } }` |
| `POST /crm/observe` | none (explicit passport) | low-trust client-reported observations |

**Identity:** each call carries a `customer: { email?, phone?, external_id? }`; CRM
resolves or creates the passport (returns `202` if no identity given). **Awareness:**
notes → channel `crm`, direction `observation`. The browser client plugin
(`whitebox-pro-client-plugin-crm`) reports UI observations (`completed onboarding`,
`added to cart`) tagged `source: client`. MCP: `crm.upsert_record`, `crm.add_fact`,
`crm.get_state` (current `{ key: value }` facts; for history/transitions/cross-customer
use the core `whitebox.query`). The old `whitebox_crm_records` table was dropped.

→ [`whitebox-pro-server-plugin-crm`](../server-plugin-crm).

---

## VoIP

Turns an Asterisk PBX into a tracked, recorded, transcribed channel. Assigns
trackable phone numbers to engaged web visitors, correlates the inbound call back to
their session/passport, records the audio, transcribes it (Whisper + GPT cleanup),
and writes the conversation into awareness.

```js
voip({
  country: 'BG', language: 'bg-BG', transcription: true,
  recordsFolder: 'recordings',
  lines: [ { tag: 'sales', in: ['+35924000000'], out: ['+359880000000'], strategy: 'hunt' } ],
  ari: { url: process.env.WB_ARI_URL, user: process.env.WB_ARI_USER, password: process.env.WB_ARI_PASSWORD },
  webhooks: { ring: {…}, pick: {…}, call: {…} },
})
```

| endpoint | auth | purpose |
|---|---|---|
| `GET /voip/records/<uuid>.mp3` | none (unguessable) | stream a recording |

**Awareness:** channel `voip`, direction `conversation` (the transcript). **Concepts:**
a number **pool** per line tag; calls move `ringing → active → ended`/`missed`;
each call has a stable `vault_id`. Recording/transcription are best-effort (failure
in one doesn't lose the call). Notify topics `voip.ring`/`pick`/`call`. Requires PBX
ARI setup (see the package README). MCP: `voip.list_calls`, `get_call`,
`get_transcript`.

→ [`whitebox-pro-server-plugin-voip`](../server-plugin-voip) · client:
`whitebox-pro-client-plugin-voip` (number swap-in via `data-wb-phone`).

---

## Conversions

Unified conversion tracking. The browser fires the ad-platform pixels **and** posts
events to the server; the server records them as first-party signals and fans out to
**Meta CAPI / GA4 MP / TikTok Events API**, deduped with the browser pixel by a
shared `event_id`.

```js
conversions({
  auth: { secret: process.env.WB_CONVERSIONS_TOKEN },   // for the GET audit endpoint
  networks: [
    meta({ pixelId, accessToken }),
    tiktok({ pixelCode, accessToken }),
    // GA4 is usually client-side only — see the dedup note below
  ],
})
```

| endpoint | auth | purpose |
|---|---|---|
| `POST /conversions/events` | none (browser) | ingest `{ passport_id, events, signals }` |
| `GET /conversions/events` | Bearer | audit log |

**Dedup:** Meta and TikTok run *both* pixel and server API, deduped by `event_id`.
GA4 has no `gtag`↔Measurement-Protocol dedup, so run it on **one side only**
(usually client `gtag`). **Standard events** (`purchase`, `lead`, `viewContent`, …)
are schema-validated; custom events pass through. With no networks, conversions still
record to awareness (`conversion`). MCP: `conversions.list_events`.

→ [`whitebox-pro-server-plugin-conversions`](../server-plugin-conversions)
· client: `whitebox-pro-client-plugin-conversions` · networks: [Integrations](08-integrations.md).

---

## Audiences

An AI audience builder. A **rule** is a saved core **selector** (or a funnel slot);
the core selector engine (`ctx.selector`) resolves the qualified cohort and the
plugin only **activates** it — for each qualifying passport it fires a custom event
to Meta/TikTok/GA4, which build and age the actual audience. WhiteBox owns
*qualification*; the platform owns *membership*.

```js
audiences({
  auth: { secret: process.env.WB_AUDIENCES_TOKEN },
  evaluation: { model: 'gpt-4o-mini', keepWarmDays: 7 },
  networks: [ meta({…}), tiktok({…}), google({…}) ],
  privacy: { requireConsentCategory: 'marketing',
             sensitiveCategories: ['health','finance','religion','sexuality','politics'] },
})
```

A rule has **exactly one source**. Either a `select` — a core selector of
`{ about, filter, judge }` (`about` = semantic narrow, `filter` = boolean tree of
`fact` + `metric` clauses, `judge` = optional LLM membership predicate) — or a
`funnel` + `slot` (`"step:N"` | `"gap:N→M"`, with an optional `status`
pending/dropped — the retargeting payoff):

```js
{ id: 'enterprise_ready', name: 'Ready for Enterprise', enabled: true,
  select: {
    about:  'SSO, security, scale, seat limits',
    filter: { all: [ { fact: { plan_tier: { eq: 'pro' } } },
                     { metric: { content: 'pricing', count: { gte: 1 }, last: '30d' } } ] },
    judge:  { criteria: 'genuinely evaluating an Enterprise upgrade', confidence: 0.7 } },
  ttl_days: 30,
  delivery: { meta: { event: 'wb_enterprise_ready' }, tiktok: { event: 'wb_enterprise_ready' } } }
```

The plugin delegates all selection to the engine; it only handles activation
(deliver Mode-A events to Meta/TikTok/GA4) and keep-warm. A rich REST + MCP surface
lets you draft (AI), preview (dry-run with cost), create, evaluate, and inspect rules
and deliveries — e.g. `POST /audiences/rules`, `…/rules/:id/preview`,
`GET /audiences/deliveries`. MCP: `audiences_draft_rule`, `audiences_preview_rule`,
`audiences_create_rule`, `audiences_evaluate`, `audiences_explain_match`, …

The audiences package ships a full multi-chapter guide of its own.

→ [`whitebox-pro-server-plugin-audiences`](../server-plugin-audiences) ·
its [docs/](../server-plugin-audiences/docs).

---

## Shortener

Short links on their own host, with native **UTM** decoration and **personalized**
links that hard-bind the clicker's session to a passport (the id never appears in
the URL). Used directly, or by mail's `data-wb-shorten` link personalization.

```js
shortener({
  baseUrl: process.env.WB_SHORTENER_BASEURL || 'https://go.example.com',
  auth: { secret: process.env.WB_SHORTENER_TOKEN },
})
```

| endpoint | auth | purpose |
|---|---|---|
| `POST /shortener/links` | Bearer | create a (optionally personalized, UTM-decorated) link |
| `GET /:code` | none | redirect (the `baseUrl` host gates this) |

**Awareness:** a click on a personalized link records `expression` on channel `web`
and binds the visitor to the passport. MCP: `shortener.create_link`, `list_links`,
`link_stats`.

→ [`whitebox-pro-server-plugin-shortener`](../server-plugin-shortener).

---

## Analytics

Not a touch channel — the **read** surface over everything above (`ask`, `recall`,
`population`, `timeline`, `context`, `forget`). Covered in
[05 · Awareness & querying](05-awareness-and-querying.md).

```js
analytics({ auth: { secret: process.env.WB_ANALYTICS_TOKEN } })
```

Next: **[08 · Integrations](08-integrations.md)**.
