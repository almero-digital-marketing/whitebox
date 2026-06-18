# 07 · CRM integration

The `crm` feature lets rules gate on **state** (`plan_tier`, `seat_count`, `mrr`, `hit seat limit`, …).
The hard question: **how do you integrate with a CRM you don't know in advance?**

## You don't integrate with the CRM — you invert it

WhiteBox does **not** build a connector per CRM. It exposes a **generic, identity-keyed facts webhook**
(the `/crm/facts` ingestion) and the customer's CRM (or an iPaaS) **pushes** into it.

```
   ANY CRM (Salesforce / HubSpot / Pipedrive / spreadsheet / custom)
        │  native webhook · Zapier/Make/n8n · iPaaS · a 3-line script
        ▼
   POST /crm/facts  { identity:{email|phone|external_id}, facts:{ any_key: value }, ts }
        │  identity resolution → passport (mint or match)
        ▼
   per-passport facts (arbitrary key→value, typed, timestamped)
        │  one generic provider registered as context 'crm'
        ▼
   context.collect(passport, { providers:['crm'] })  →  the crm feature
```

Why this handles an **unknown** CRM with zero CRM-specific code:

1. **Schema-light contract.** WhiteBox accepts a generic `{ identity, facts }` envelope. The customer
   maps their CRM's fields to it once. WhiteBox never knows which CRM — it resolves the identity to a
   passport and stores the facts.
2. **Arbitrary key/value (schema-on-read).** No pre-defined keys. Whatever arrives is stored; rules
   reference keys by name (`requires.crm: ['plan_tier']`).
3. **Self-describing.** The plugin caches the distinct fact keys it sees
   (`whitebox_audience_fact_keys`) so authoring isn't guesswork — `audiences_list_facts` /
   `GET /audiences/facts` answer *"what do you know about my users?"*.
4. **`requires` keeps it safe.** `preview` checks each `requires.crm` key against the discovered keys
   and warns if a rule depends on a fact you're **not** ingesting (so it never silently under-matches).
5. **Native connectors are optional sugar.** A one-click HubSpot/Salesforce connector is just something
   that translates into the *same* `/crm/facts` shape. The baseline works with any CRM via the webhook.

## The fact envelope

```json
POST /crm/facts
{
  "identity": { "email": "ada@acme.com" },        // or phone / external_id — anything resolvable
  "facts": { "plan_tier": "pro", "seat_count": 5, "mrr": 240, "seat_limit_hit": true,
             "trial_ends_at": "2026-06-25" },
  "ts": "2026-06-17T10:00:00Z"
}
```

- **Identity** must be something WhiteBox can resolve to a passport (the same resolution the CRM
  records/facts ingestion already does — mint if new, match if known).
- **Facts** are a flat bag. Latest-wins per key.

## How the plugin reads them

`features/crm.js` calls `context.collect(passport, { providers: ['crm'] })`, flattens the result to a
key→value bag, and opportunistically records the keys it sees for discovery. The `crm` provider itself
is registered by the CRM ingestion (or you register one that reads your facts table). The audiences
plugin **consumes** context — it doesn't own the facts store.

## Typing and freshness

- **Type inference** (in the discovery cache): `number | bool | date | string`, so rules can do
  `mrr > 500` and date comparisons. For strict typing, have the webhook declare types.
- **Freshness:** facts carry `ts`. A rule can require a fact be *fresh* (add a `recency`-style check
  in your provider, or compare `ts` in the judge). Stale state is a real risk for ad targeting —
  prefer recent facts.

## Discovery in practice

```
GET /audiences/facts
→ [ { key:"plan_tier", type:"string", sample:"pro", last_seen:"2026-06-17" },
    { key:"seat_count", type:"number", sample:5 },
    { key:"mrr", type:"number", sample:240 } ]
```

Author rules from what's *actually* flowing, not from a guess. If a rule needs `renewal_date` and it's
not in this list, `preview` will tell you before you ship it.

## The one gap to wire

`awareness.recorded` fires on content exposures (web/mail/voip) but **not** on a CRM-fact-only update.
So a passport whose only new signal is a fresh CRM fact won't be re-evaluated by the dirty trigger.
Options:
- have the CRM ingestion **also** publish a dirty signal the audiences plugin subscribes to, or
- rely on the **keep-warm / scheduled sweep** to re-evaluate periodically (good enough for slow-moving
  CRM state like plan tier).
