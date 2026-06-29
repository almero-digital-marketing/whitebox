# `whitebox_ad_insights` schema + ROAS join (Phase-0 first brick)

> Part of the [Connect layer](whitebox-connect.md) (§4.4 / §6), but **needs none of
> the gateway** — this is the self-hosted side that closes the measurement loop with
> a free CSV import. Build this **first**; the managed pull (Connect) and BYO
> providers both just feed the same table later.
>
> Lives in a new channel plugin **`server-plugin-insights`** (mirrors
> `server-plugin-conversions`). **Status:** design / not started.

---

## 1. What it is

The **paid-media** side of ROAS: daily, aggregate, campaign-level ad metrics. It's
**source-agnostic** — rows land identically whether they came from CSV (free),
WhiteBox Connect (managed), or a BYO direct provider — so the downstream
UTM⨝conversion query is written once. **No PII**; the `UNIQUE` key makes ingest
idempotent (re-pulling a window re-upserts).

---

## 2. Migration (matches the repo's knex style)

`server-plugin-insights/src/migrations/001_create_ad_insights.js`:

```js
// Ad insights — daily paid-media metrics (spend/impressions/clicks) pulled from the
// ad platforms or imported from CSV: the PAID side of the ROAS join. Source-agnostic
// so the downstream UTM⨝conversion query is identical for Connect / BYO / CSV. NO PII —
// aggregate, campaign-level only. The UNIQUE key makes ingest idempotent (re-pulling
// a window just re-upserts). See plans/ad-insights-schema.md.

export async function up(knex) {
  await knex.schema.createTable('whitebox_ad_insights', t => {
    t.uuid('id').primary()
    t.text('source').notNullable()                       // 'meta' | 'google' | 'tiktok' | 'csv'
    t.text('account_id').notNullable()                   // platform ad-account id
    t.text('level').notNullable().defaultTo('campaign')  // 'campaign' | 'adset' | 'ad'
    t.text('entity_id').notNullable()                    // platform id at that level
    t.text('entity_name')
    t.text('campaign_id')                                // parent ids at finer levels (enable rollup)
    t.text('adset_id')
    t.date('date').notNullable()                         // platform-LOCAL reporting day (tz noted in raw)

    // metrics
    t.string('currency', 8)
    t.decimal('spend', 18, 4).notNullable().defaultTo(0)
    t.bigInteger('impressions').notNullable().defaultTo(0)
    t.bigInteger('clicks').notNullable().defaultTo(0)
    t.decimal('conversions', 18, 4)                      // PLATFORM-reported — kept SEPARATE from first-party
    t.decimal('revenue', 18, 4)                          // PLATFORM-reported — kept SEPARATE from first-party

    // the join key — parsed from naming / tracking template by the adapter's normalize()
    t.text('utm_source')
    t.text('utm_medium')
    t.text('utm_campaign')
    t.jsonb('utm')                                       // overflow: { content, term, ... }

    // provenance
    t.jsonb('raw')                                       // source row, for re-derivation / debugging
    t.text('batch_id')                                   // CSV import or sync-run id (trace / rollback)
    t.timestamp('synced_at', { useTz: true }).defaultTo(knex.fn.now())

    t.unique(['source', 'account_id', 'level', 'entity_id', 'date'])  // idempotent ingest
    t.index(['utm_campaign', 'date'])                    // the ROAS join/group key
    t.index('date')
    t.index(['source', 'account_id'])
  })
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('whitebox_ad_insights')
}
```

**Key choices**
- **Grain = (source, account, level, entity, day).** Daily is enough for ROAS;
  `level` + parent ids let finer pulls (adset/ad) roll up to campaign later. v1 pulls
  campaign-level only.
- **Platform-reported `conversions`/`revenue` are stored but kept separate** from
  first-party conversion revenue — different attribution windows, never silently merged.
- **UTM as explicit columns** (joinable/indexable/groupable) + a `utm` jsonb for the
  rest. `normalize()` in the adapter fills them from the campaign's tracking template
  or a naming convention.
- **No breakdown dimensions in v1** (country/placement). If added, they must join the
  `UNIQUE` key — note for later.

---

## 3. Idempotent upsert

```js
import { randomUUID } from 'node:crypto'

export async function upsertInsight(db, row) {
  await db('whitebox_ad_insights')
    .insert({ id: randomUUID(), ...row, synced_at: db.fn.now() })
    .onConflict(['source', 'account_id', 'level', 'entity_id', 'date'])
    .merge([                                   // re-pull overwrites metrics, keeps the row identity
      'entity_name', 'campaign_id', 'adset_id', 'currency',
      'spend', 'impressions', 'clicks', 'conversions', 'revenue',
      'utm_source', 'utm_medium', 'utm_campaign', 'utm', 'raw', 'batch_id', 'synced_at',
    ])
}
```

Re-pulling a recent window (platforms restate the last few days as attribution
settles) is safe — the merge overwrites in place.

---

## 4. The free path — `csv()` source (Phase-0, no external deps)

A normalized-CSV contract (one row per campaign-day) keeps the importer trivial;
per-platform exports are mapped to it by a small column map.

```
date,account_id,campaign_id,campaign_name,spend,impressions,clicks,currency,utm_campaign
2026-06-01,act_123,c_99,Spring Refresh,420.50,18400,512,EUR,spring_refresh
```

```js
// server-plugin-insights — import a normalized CSV as source='csv'
export async function importCsv(db, rows, { batch_id }) {
  for (const r of rows) {
    await upsertInsight(db, {
      source: 'csv', account_id: r.account_id, level: 'campaign',
      entity_id: r.campaign_id, entity_name: r.campaign_name,
      date: r.date, currency: r.currency,
      spend: num(r.spend), impressions: int(r.impressions), clicks: int(r.clicks),
      utm_campaign: r.utm_campaign || slug(r.campaign_name),   // fall back to naming convention
      raw: r, batch_id,
    })
  }
}
```

Real platform exports (Meta Ads Manager, Google Ads, TikTok) get a per-export
header map (`{'Amount spent (EUR)': 'spend', 'Day': 'date', ...}`) → the same
contract → the same `upsertInsight`. The managed Connect pull lands here too, via
the adapter's `normalize()`; nothing downstream changes.

---

## 5. The payoff — UTM → conversion ROAS

Paid side from `whitebox_ad_insights` (owned here); earned side = first-party
**conversions** attributed to the same `utm_campaign`. "Conversion" is whatever
revenue event the customer tracks (a purchase, a signup, a lead, an order, a
booking, …) — it's a **configurable event name**, never hardcoded.

```sql
-- ROAS per campaign over [:since, :until].
-- PAID side:   whitebox_ad_insights (this plugin).
-- EARNED side: first-party conversions carrying utm_campaign. :conversion_event is
--   the customer's revenue event ('purchase' | 'signup' | 'lead' | 'order' | …) —
--   NOT a fixed entity. The CTE below is ILLUSTRATIVE — it binds to the core
--   event/session UTM model (session attribution); in practice this report is
--   generated through the Analytics compose pipeline, which already knows that
--   model. Don't hand-maintain it.
WITH paid AS (
  SELECT utm_campaign,
         SUM(spend)       AS spend,
         SUM(impressions) AS impressions,
         SUM(clicks)      AS clicks
  FROM whitebox_ad_insights
  WHERE date BETWEEN :since AND :until
    AND utm_campaign IS NOT NULL
  GROUP BY utm_campaign
),
earned AS (                                  -- resolves via the core's attributed conversions
  SELECT s.utm_campaign,
         COUNT(*)     AS conversions,
         SUM(e.value) AS revenue
  FROM whitebox_events e
  JOIN whitebox_sessions s ON s.id = e.session_id
  WHERE e.name = :conversion_event           -- configurable per customer/report, not 'booking'
    AND e.occurred_at::date BETWEEN :since AND :until
    AND s.utm_campaign IS NOT NULL
  GROUP BY s.utm_campaign
)
SELECT COALESCE(p.utm_campaign, e.utm_campaign)               AS campaign,
       p.spend, p.clicks, e.conversions, e.revenue,
       CASE WHEN p.spend       > 0 THEN e.revenue / p.spend      END AS roas,
       CASE WHEN e.conversions > 0 THEN p.spend  / e.conversions END AS cost_per_conversion
FROM paid p
FULL OUTER JOIN earned e USING (utm_campaign)
ORDER BY roas DESC NULLS LAST;
```

The **whole point**: spend → revenue → ROAS per campaign, and **no user-level data
ever left the instance** — the earned side resolves locally against masked passport
data; only aggregate spend came in.

---

## 6. Caveats baked into v1

- **Single currency assumed** (the design-partner customer is one currency). Multi-
  currency = convert at report time later; `currency` is stored now so it's not lost.
- **Attribution window:** the earned side's window may need a lookback offset from the
  paid `date` (a click today → a conversion next week). Make the window a report param;
  don't bake a fixed offset into the schema.
- **Don't confuse the two revenues:** platform-reported `revenue`/`conversions` are
  the ad network's own attribution — keep them as a sanity cross-check, never as the
  ROAS numerator (that's first-party conversion revenue).
- **Late restatement** is handled by the keyed upsert (re-pull recent days).

---

## 7. Build order

1. `server-plugin-insights` package + this migration + `upsertInsight`.
2. `csv()` import (REST `POST /insights/import` or a CLI) → rows in the table.
3. The ROAS report through Analytics compose (a saved report + the `:since/:until`
   params) — demoable to the design-partner customer with a single CSV export.
4. *Later, no schema change:* the Connect `connect()` source + adapters (managed),
   and BYO direct providers, both upsert into this same table.
