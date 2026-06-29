// Composition HTTP surface — reports, widgets, query resolution, and the AI
// compose loop. Mounted on /analytics alongside the existing recall/ask routes
// (separate router, no path collisions). All auth-gated. The frontend three-pane
// console talks to these.
//
//   GET    /analytics/reports                 list reports (newest first)
//   POST   /analytics/reports                 { name, layout? }            → report
//   GET    /analytics/reports/:id             report + its widgets
//   PATCH  /analytics/reports/:id             { name?, layout? }
//   DELETE /analytics/reports/:id             (cascades widgets)
//   POST   /analytics/reports/:id/widgets     { kind, query, title?, presentation?, position?, provenance?, sort? }
//   PATCH  /analytics/widgets/:id             partial widget
//   DELETE /analytics/widgets/:id
//   POST   /analytics/resolve                 run an INLINE query def (live preview, no persistence)
//   POST   /analytics/widgets/:id/resolve     run a persisted widget's stored query
//   POST   /analytics/compose                 { question, report_id? } → AI assembles widgets + data
//   GET    /analytics/schema                  the queryable vocabulary (fact keys, tags) — debug
//
// A "query def" is the inline shape a widget stores (docs/analytics-concept.md §2):
//   { selector?, group?, projection?, scope?, passport?, asOf?, limit?,   // selector path
//     funnel?, named?,                                                    // funnel path
//     breakdownFact?: { key, values[] },                                  // fact-value split
//     question? }                                                         // grounded answer

import express from 'express'
import * as store from './store.js'
import * as compose from './compose.js'
import { buildHistogram } from './histogram.js'
import { maskIdentity, maskEmail, maskPhone, CONTACT_KEYS } from './mask.js'

// donut/radar render a breakdown differently (pie / polygon, same query shape); distribution is a
// histogram of one numeric variable; scatter plots two numeric facts per person; pivot/heatmap render
// a 2-D compare matrix; cohort is a retention grid.
const KINDS = new Set(['stat', 'timeseries', 'breakdown', 'donut', 'radar', 'distribution', 'scatter', 'pivot', 'heatmap', 'cohort', 'funnel', 'dropoff', 'table', 'answer'])

// Pick the best contact identity to fall back on (email > phone > user > any non-opaque) —
// only ever returned MASKED. Null when a passport has only opaque identities (fingerprint).
function bestIdentity(ids = []) {
  for (const t of ['email', 'phone', 'user']) {
    const m = ids.find((i) => i.type === t)
    if (m) return { value: m.value, type: t }
  }
  const other = ids.find((i) => i.type !== 'fingerprint')
  return other ? { value: other.value, type: other.type } : null
}

// Attach SAFE display fields to the first `limit` passports (the table renders one page).
// PII boundary: raw email/phone must never cross into the analytics app. Each row gets:
//   · label      — the person's name when known, else a masked identity, else (client) short id
//   · contacts   — { email, phone } MASKED (m•••@…, +359•••89) for the table's contact columns
// The raw identity values are never serialized. Names come from one batched query; identities
// are fetched per row (one page) and masked here before anything leaves the server.
async function enrichPeople(result, passports, limit = 100) {
  if (!Array.isArray(result?.passports)) return result
  const page = result.passports.slice(0, limit)
  const names = await store.namesByPassports(page.map((p) => p.id)).catch(() => ({}))
  await Promise.all(page.map(async (p) => {
    let ids = []
    if (passports?.identities) { try { ids = await passports.identities(p.id) } catch { /* best-effort */ } }
    const email = ids.find((i) => i.type === 'email')
    const phone = ids.find((i) => i.type === 'phone')
    if (email || phone) p.contacts = {
      ...(email ? { email: maskEmail(email.value) } : {}),
      ...(phone ? { phone: maskPhone(phone.value) } : {}),
    }
    const name = names[p.id]
    if (name) { p.label = name; p.label_type = 'name' }
    else { const best = bestIdentity(ids); if (best) { p.label = maskIdentity(best.type, best.value); p.label_type = best.type } }
  }))
  return result
}

// Resolve a list of named sub-queries into a multi-series result. Each sub-query
// goes through the full runQuery, so a series can be a cohort count, a breakdown,
// a timeseries, … whatever it returns is normalised to {bucket,value}[]. This is
// what powers "compare A vs B" (multi-line, grouped bars, overlaid radar).
async function resolveSeries(deps, subs) {
  const series = []
  for (const { name, query } of subs) {
    const r = await runQuery(deps, query || {})
    let points
    if (Array.isArray(r)) points = r
    else if (Array.isArray(r?.series)) points = r.series
    else if (r?.count != null) points = [{ bucket: String(name ?? ''), value: r.count }]
    else points = []
    series.push({ name: String(name ?? ''), points: points.map((p) => ({ bucket: String(p.bucket), value: Number(p.value) || 0 })) })
  }
  return { multi: true, series }
}

// Resolve one query def. Branches by shape so a widget can be a cohort count, a
// time-series, a fact-value breakdown, a funnel, a grounded answer, or a multi-
// series comparison (series[] / splitBy).
async function runQuery(deps, q = {}) {
  const { selector, awareness } = deps
  // `scope` confines a query to a cohort: an explicit passport-id array, OR a people
  // sub-selector (a cohort filter) resolved to ids here — so an aggregate (group/
  // timeseries), a people query, OR a grounded answer can be scoped to "active
  // customers", "VIPs", … without the caller enumerating them.
  const cohortScope = async () => {
    if (!q.scope) return undefined
    if (Array.isArray(q.scope)) return q.scope
    const c = await selector.resolve(q.scope, { projection: 'people', asOf: q.asOf })
    return c.passports.map((p) => p.id)
  }

  // ── multi-series (compare A vs B) ─────────────────────────────────────────────
  // `series`: explicit named sub-queries — compare anything vs anything.
  // `splitBy`: sugar — split the base query into one series per value of a fact,
  //   each scoped to that value (active vs lapsed, gold vs silver). Capped at 6.
  if (Array.isArray(q.series) && q.series.length) {
    return resolveSeries(deps, q.series.slice(0, 6))
  }
  if (q.splitBy?.key && Array.isArray(q.splitBy.values) && q.splitBy.values.length) {
    const { key, values } = q.splitBy
    const base = { ...q }; delete base.splitBy
    const subs = values.slice(0, 6).map((v) => ({
      name: v,
      query: { ...base, scope: { filter: { fact: { [key]: { eq: v } } } } },
    }))
    return resolveSeries(deps, subs)
  }

  if (q.question) {
    if (!awareness?.askPopulation) return { answer: 'Answers are unavailable (awareness not wired).' }
    // scope + last/from ground the generative answer in the structured cohort + window
    return awareness.askPopulation({ question: q.question, scope: await cohortScope(), last: q.last, from: q.from })
  }
  // A fact-valued group bucket is NOT a core group dimension (the engine groups by a
  // time grain, a column, session:<utm>, or attr:<key>). Resolve it the breakdownFact
  // way — one people-count per fact value. This also rescues the compose model, which
  // emits the fact key as the bucket in several forms ("fact:status", or a bare
  // "status") instead of the breakdownFact shape.
  const CORE_BUCKETS = new Set(['hour', 'day', 'week', 'month', 'channel', 'direction', 'source', 'content'])
  const by = typeof q.group?.by === 'string' ? q.group.by : null
  const factGroup = !by ? null
    : by.startsWith('fact:') ? by.slice(5)
      : (by.startsWith('session:') || by.startsWith('attr:') || CORE_BUCKETS.has(by)) ? null
        : by   // a bare token that isn't a core bucket → treat it as a fact key
  if (q.breakdownFact || factGroup) {
    const scope = await cohortScope()
    const key = q.breakdownFact?.key || factGroup
    // never break a chart down by a contact identifier — its bucket labels would be raw PII
    if (CONTACT_KEYS.has(key)) { const e = new Error(`cannot group by the identity field "${key}"`); e.status = 400; throw e }
    let values = q.breakdownFact?.values
    if (!values || !values.length) values = await store.factDistinctValues(key, scope)
    const series = []
    for (const v of values) {
      const r = await selector.resolve({ filter: { fact: { [key]: { eq: v } } } }, { projection: 'people', asOf: q.asOf, scope })
      series.push({ bucket: String(v), value: r.count })
    }
    return { series }
  }
  if (q.distribution) {
    // Histogram of a numeric fact's value per person, or of how many of an event
    // each person did. Binned in JS (auto, or explicit `bins` edges) — never via
    // the fact predicate (its comparator mis-orders numeric strings as dates).
    const { source = 'fact', key, bins, maxBins } = q.distribution
    if (!key) throw new Error('distribution requires a key')
    const scope = await cohortScope()
    const values = source === 'event'
      ? await store.eventCounts(key, scope)
      : await store.factValues(key, scope)
    return buildHistogram(values, { bins, maxBins })
  }
  if (q.scatter) {
    // One dot per person at (factX, factY); optional colorBy groups the dots.
    // Two numeric facts read raw + cast (never via the fact predicate).
    const { x, y, colorBy, limit } = q.scatter
    if (!x || !y) throw new Error('scatter requires x and y fact keys')
    const points = await store.factPairs(x, y, { scope: await cohortScope(), colorBy, limit })
    return { points, x, y, ...(colorBy ? { colorBy } : {}) }
  }
  if (q.cohort) {
    // Retention grid: cohort = each person's FIRST active period; cell = % of that
    // cohort still active k periods later. Rendered as a matrix (rows × M0..Mn).
    const { event, grain = 'month', periods = 6 } = q.cohort
    const rows = await store.cohortRows(event, grain, await cohortScope())
    const idxOf = (d) => grain === 'week'
      ? Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / (7 * 864e5))
      : d.getUTCFullYear() * 12 + d.getUTCMonth()
    const labelOf = (n) => grain === 'week' ? `wk ${n}` : `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}`
    const byId = new Map()
    for (const { id, p } of rows) { if (!byId.has(id)) byId.set(id, []); byId.get(id).push(idxOf(p)) }
    const cohorts = new Map()   // firstIdx → { size, active: Map(offset → count) }
    for (const idxs of byId.values()) {
      const first = Math.min(...idxs)
      let c = cohorts.get(first); if (!c) cohorts.set(first, c = { size: 0, active: new Map() })
      c.size++
      for (const off of new Set(idxs.map((i) => i - first))) {
        if (off >= 0 && off <= periods) c.active.set(off, (c.active.get(off) || 0) + 1)
      }
    }
    const cohortIdxs = [...cohorts.keys()].sort((a, b) => a - b)
    const offsets = Array.from({ length: periods + 1 }, (_, k) => k)
    const series = offsets.map((k) => ({
      name: `${grain === 'week' ? 'W' : 'M'}${k}`,
      points: cohortIdxs.map((ci) => {
        const c = cohorts.get(ci)
        return { bucket: labelOf(ci), value: c.size ? Math.round((c.active.get(k) || 0) / c.size * 100) : 0 }
      }),
    }))
    return { multi: true, cohort: true, unit: '%', series, sizes: cohortIdxs.map((ci) => ({ cohort: labelOf(ci), size: cohorts.get(ci).size })) }
  }
  if (q.funnel) {
    const f = await selector.funnel(q.funnel, { asOf: q.asOf, named: q.named })
    // shape the drop-off report into a chartable series (each step a bar)
    return { series: (f.report || []).map((s) => ({ bucket: s.name || `Step ${s.step}`, value: s.count })), report: f.report }
  }
  return selector.resolve(q.selector || {}, {
    projection: q.projection, scope: await cohortScope(), passport: q.passport,
    asOf: q.asOf, limit: q.limit, group: q.group,
  })
}

// Reduce a widget's resolved data to the essentials the explainer needs (and a stable
// fingerprint to cache by). Keeps the AI prompt small and skips identity/PII rows.
const seriesOf = (d) => (Array.isArray(d) ? d : d?.series || [])
function compactForExplain(kind, data) {
  if (data?.multi) {   // a comparison — give the explainer each named series so it can say which leads
    return { comparison: (data.series || []).map((s) => ({ name: s.name, points: s.points.slice(0, 40).map((p) => [p.bucket, p.value]) })) }
  }
  if (kind === 'stat') return { count: data?.count ?? 0, ...(data?.target ? { target: data.target, pctOfTarget: Math.round((data.count / data.target) * 100) } : {}) }
  if (kind === 'table') return { count: data?.count ?? data?.passports?.length ?? 0 }
  if (kind === 'funnel') return { steps: (data?.report || seriesOf(data)).map((s) => [s.name ?? s.bucket, s.count ?? s.value]) }
  if (kind === 'dropoff') {   // a drop-off is about LOSS — give the explainer the people lost at each step (the re-engagement audiences)
    const steps = (data?.report || seriesOf(data)).map((s) => [s.name ?? s.bucket, s.count ?? s.value])
    const drops = []
    for (let i = 0; i < steps.length - 1; i++) {
      const from = steps[i][1] || 0, lost = Math.max(0, from - (steps[i + 1][1] || 0))
      drops.push({ from: steps[i][0], to: steps[i + 1][0], lost, pct: from ? Math.round((lost / from) * 100) : 0 })
    }
    return { drops }
  }
  if (kind === 'donut') {   // a donut is about SHARE — give the explainer each slice's percent, not just the count
    const s = seriesOf(data)
    const total = s.reduce((a, b) => a + (b.value || 0), 0) || 1
    return { total, slices: s.slice(0, 40).map((b) => [b.bucket, b.value, `${Math.round((b.value / total) * 100)}%`]) }
  }
  if (kind === 'scatter') {   // a scatter is about RELATIONSHIP — summarise ranges + correlation, not raw dots
    const pts = (Array.isArray(data) ? data : data?.points) || []
    const n = pts.length
    const rng = (sel) => { const v = pts.map(sel); return n ? { min: Math.min(...v), max: Math.max(...v) } : null }
    let r = null
    if (n > 1) {
      const mean = (sel) => pts.reduce((a, p) => a + sel(p), 0) / n
      const mx = mean((p) => p.x), my = mean((p) => p.y)
      let sxy = 0, sx = 0, sy = 0
      for (const p of pts) { const dx = p.x - mx, dy = p.y - my; sxy += dx * dy; sx += dx * dx; sy += dy * dy }
      if (sx > 0 && sy > 0) r = Math.round((sxy / Math.sqrt(sx * sy)) * 100) / 100   // Pearson, 2dp
    }
    return { n, x: data?.x, y: data?.y, xRange: rng((p) => p.x), yRange: rng((p) => p.y), correlation: r }
  }
  return { series: seriesOf(data).slice(0, 40).map((b) => [b.bucket, b.value]) }   // timeseries / breakdown / distribution
}
// fingerprint → explanation. In-memory: regenerate only when a widget's RESULT changes
// (the frontend re-requests on every resolve; unchanged data is a cache hit, no AI call).
const explainCache = new Map()
// report-state fingerprint → suggested questions (the compose "Try one:" chips).
const suggestCache = new Map()

export function mountComposition(app, { requireAuth, selector, awareness, passports, logger }) {
  const router = express.Router()
  const deps = { selector, awareness }
  const fail = (res, err, msg) => { logger.error({ err }, msg); res.status(500).json({ error: msg }) }
  // Live broadcasts are emitted by the store on every mutation (caller-agnostic).
  // Best-effort describe for the widget summary — a failure just leaves it blank.
  const describeSafe = async (query) => {
    try { return await compose.describeQuery(query) }
    catch (err) { logger.warn({ err }, 'describe (widget summary) failed'); return null }
  }

  // ── reports ────────────────────────────────────────────────────────────────
  router.get('/reports', requireAuth, async (req, res) => {
    try { res.json({ data: await store.listReports() }) }
    catch (err) { fail(res, err, 'list reports failed') }
  })

  router.post('/reports', requireAuth, async (req, res) => {
    const { name, layout } = req.body || {}
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' })
    try { res.status(201).json(await store.createReport({ name, layout })) }
    catch (err) { fail(res, err, 'create report failed') }
  })

  router.get('/reports/:id', requireAuth, async (req, res) => {
    try {
      const report = await store.getReport(req.params.id)
      if (!report) return res.status(404).json({ error: 'report not found' })
      res.json(report)
    } catch (err) { fail(res, err, 'get report failed') }
  })

  router.patch('/reports/:id', requireAuth, async (req, res) => {
    try {
      const row = await store.updateReport(req.params.id, req.body || {})
      if (!row) return res.status(404).json({ error: 'report not found' })
      res.json(row)
    } catch (err) { fail(res, err, 'update report failed') }
  })

  router.delete('/reports/:id', requireAuth, async (req, res) => {
    try { res.json({ deleted: await store.deleteReport(req.params.id) }) }
    catch (err) { fail(res, err, 'delete report failed') }
  })

  // ── widgets ──────────────────────────────────────────────────────────────────
  router.post('/reports/:id/widgets', requireAuth, async (req, res) => {
    const w = req.body || {}
    if (!KINDS.has(w.kind)) return res.status(400).json({ error: `kind must be one of ${[...KINDS].join(', ')}` })
    if (!w.query || typeof w.query !== 'object') return res.status(400).json({ error: 'query (object) is required' })
    try {
      const report = await store.getReport(req.params.id)
      if (!report) return res.status(404).json({ error: 'report not found' })
      const row = await store.addWidget(req.params.id, w)
      res.status(201).json(row)
    } catch (err) { fail(res, err, 'add widget failed') }
  })

  router.patch('/widgets/:id', requireAuth, async (req, res) => {
    if (req.body?.kind && !KINDS.has(req.body.kind)) return res.status(400).json({ error: 'invalid kind' })
    try {
      // store.updateWidget nulls the summary when the query changes, so the next view
      // re-summarises (AI runs once per query version, not on every save).
      const row = await store.updateWidget(req.params.id, req.body || {})
      if (!row) return res.status(404).json({ error: 'widget not found' })
      res.json(row)
    } catch (err) { fail(res, err, 'update widget failed') }
  })

  // The widget summary = the AI's plain-language reading of the query (the same text
  // the Agent tab shows). Generated lazily on first request and persisted, so the AI
  // runs ONCE per query version — keeping add/compose/save fast. Re-runs only after a
  // query edit (which clears the stored summary).
  router.post('/widgets/:id/summary', requireAuth, async (req, res) => {
    try {
      const w = await store.getWidget(req.params.id)
      if (!w) return res.status(404).json({ error: 'widget not found' })
      if (w.summary) return res.json({ summary: w.summary, cached: true })
      const summary = await describeSafe(w.query)
      if (summary) await store.updateWidget(req.params.id, { summary })
      res.json({ summary })
    } catch (err) { res.status(502).json({ error: `summary failed: ${err.message}` }) }
  })

  router.delete('/widgets/:id', requireAuth, async (req, res) => {
    try { res.json({ deleted: await store.deleteWidget(req.params.id) }) }
    catch (err) { fail(res, err, 'delete widget failed') }
  })

  // Drag-to-reorder: body { order: [widgetId, …] } → sort follows the array.
  router.patch('/reports/:id/reorder', requireAuth, async (req, res) => {
    const order = req.body?.order
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order (array of widget ids) is required' })
    try { await store.reorderWidgets(req.params.id, order); res.json({ ok: true }) }
    catch (err) { fail(res, err, 'reorder widgets failed') }
  })

  // ── resolve ──────────────────────────────────────────────────────────────────
  router.post('/resolve', requireAuth, async (req, res) => {
    try {
      let data = await runQuery(deps, req.body || {})
      if (req.body?.kind === 'table') data = await enrichPeople(data, passports)   // live preview of a people table
      res.json(data)
    } catch (err) { res.status(400).json({ error: err.message }) }
  })

  router.post('/widgets/:id/resolve', requireAuth, async (req, res) => {
    try {
      const w = await store.getWidget(req.params.id)
      if (!w) return res.status(404).json({ error: 'widget not found' })
      let data = await runQuery(deps, w.query)   // w.query is parsed jsonb
      if (w.kind === 'table') data = await enrichPeople(data, passports)   // label the rows people see
      res.json(data)
    } catch (err) { res.status(400).json({ error: err.message }) }
  })

  // ── compose (the "just ask" loop) ─────────────────────────────────────────────
  // question → AI assembles widgets → persisted into a (draft) report → each
  // resolved so the board can render immediately.
  router.post('/compose', requireAuth, async (req, res) => {
    const { question, report_id } = req.body || {}
    if (!question || typeof question !== 'string') return res.status(400).json({ error: 'question is required' })
    try {
      const specs = await compose.composeWidgets(question)

      let report = report_id ? await store.getReport(report_id) : null
      if (!report) report = await store.createReport({ name: question.slice(0, 80) })
      let sort = report.widgets?.length || 0

      const widgets = []
      for (const s of specs) {
        // Validate the generated query by resolving it BEFORE persisting — a widget whose query
        // the selector rejects (the AI mis-shaped it) is dropped, never saved. A report only ever
        // contains widgets that actually render; no broken tiles. (The resolved data is reused.)
        let data
        try { data = await runQuery(deps, s.query) }
        catch (e) {
          logger.warn({ err: e.message, title: s.title, kind: s.kind }, 'compose: dropping widget whose query failed to resolve')
          continue
        }
        const row = await store.addWidget(report.id, { ...s, provenance: 'ai', sort: sort++ })
        if (row.kind === 'table') { try { data = await enrichPeople(data, passports) } catch { /* keep raw */ } }
        widgets.push({ ...row, data, error: null })
      }
      res.json({ report: { id: report.id, name: report.name }, widgets })
    } catch (err) {
      logger.error({ err }, 'compose failed')
      res.status(502).json({ error: `compose failed: ${err.message}` })
    }
  })

  // ── describe — query def → plain-language question (inverse of compose) ────────
  router.post('/describe', requireAuth, async (req, res) => {
    try { res.json({ summary: await compose.describeQuery(req.body?.query || {}) }) }
    catch (err) { res.status(502).json({ error: `describe failed: ${err.message}` }) }
  })

  // ── explain — a widget's RESULT → a 1–2 sentence plain insight (the left column) ─
  // Stateless: the frontend posts the data it already rendered, so we don't re-resolve.
  // Cached by a result fingerprint → only regenerates when the data actually changes.
  router.post('/explain', requireAuth, async (req, res) => {
    const { id, title, kind, data } = req.body || {}
    if (!kind || kind === 'answer') return res.json({ explanation: null })   // answers are already prose
    try {
      const compact = compactForExplain(kind, data)
      // Key by widget id (not just title): two distinct widgets that reduce to the same
      // compacted numbers — common for empty/zero results, or stat/table → just {count} —
      // must not share a cached insight. id still lets the SAME widget re-cache on data change.
      const fp = `${id || title || ''}::${kind}::${JSON.stringify(compact)}`
      if (explainCache.has(fp)) return res.json({ explanation: explainCache.get(fp), cached: true })
      const explanation = await compose.explainWidget({ title, kind, data: compact })
      if (explainCache.size > 500) explainCache.clear()                       // bounded
      explainCache.set(fp, explanation)
      res.json({ explanation })
    } catch (err) { res.status(502).json({ error: `explain failed: ${err.message}` }) }
  })

  // ── person insight — ONE selected list row → a 1–2 sentence profile of them ────
  // Drives the list widget's insight column when a client is selected. Gathers the
  // person's facts + recent activity here, then the AI profiles them. Cached by
  // passport id (+ list context), bounded.
  const personCache = new Map()
  router.post('/people/:id/insight', requireAuth, async (req, res) => {
    const id = req.params.id
    const { context } = req.body || {}   // the client-sent label is ignored — `who` is derived server-side
    try {
      const ck = `${id}::${context || ''}`
      if (personCache.has(ck)) return res.json({ explanation: personCache.get(ck), cached: true })
      const [facts, activity] = await Promise.all([store.personFacts(id), store.personActivity(id)])
      // PII boundary: never put a raw contact identifier in the LLM prompt. Name is allowed.
      const safeFacts = Object.fromEntries(Object.entries(facts).filter(([k]) => !CONTACT_KEYS.has(k)))
      const who = safeFacts.full_name || id.slice(0, 8)
      const explanation = await compose.explainPerson({ who, facts: safeFacts, activity, context })
      if (personCache.size > 500) personCache.clear()
      personCache.set(ck, explanation)
      res.json({ explanation })
    } catch (err) { res.status(502).json({ error: `person insight failed: ${err.message}` }) }
  })

  // ── suggestions — the compose box "Try one:" chips, grounded in the report ─────
  // Clue hierarchy (see compose.suggestQuestions): existing widgets → meaningful
  // name → just the data vocabulary. ?report_id scopes to that report's state; no
  // report_id → generic starters. Cached by report-state fingerprint. On any
  // failure we 200 with an empty list so the frontend keeps its static defaults.
  router.get('/suggestions', requireAuth, async (req, res) => {
    try {
      let name = '', widgets = []
      if (req.query.report_id) {
        const report = await store.getReport(req.query.report_id)
        if (report) {
          name = report.name || ''
          widgets = (report.widgets || []).map((w) => ({ title: w.title, kind: w.kind }))
        }
      }
      const fp = `${name}::${widgets.map((w) => `${w.kind}:${w.title}`).join('|')}`
      if (suggestCache.has(fp)) return res.json({ suggestions: suggestCache.get(fp), cached: true })
      const suggestions = await compose.suggestQuestions({ name, widgets })
      if (suggestCache.size > 200) suggestCache.clear()
      suggestCache.set(fp, suggestions)
      res.json({ suggestions })
    } catch (err) {
      logger.warn({ err }, 'suggestions failed')
      res.json({ suggestions: [] })   // soft-fail → frontend keeps its defaults
    }
  })

  // ── schema (debug — what the AI is grounded on) ───────────────────────────────
  router.get('/schema', requireAuth, async (req, res) => {
    try { res.json(await compose.discoverSchema({ refresh: req.query.refresh === '1' })) }
    catch (err) { fail(res, err, 'schema discovery failed') }
  })

  app.use('/analytics', router)
}
