// Composition store — knex CRUD over whitebox_reports / whitebox_widgets.
// Module singleton (init + free functions), the same pattern as core
// awareness/facts and the audiences plugin store. jsonb columns are written
// JSON.stringify'd and come back parsed by node-pg (matches facts/store.js).
//
// Every mutation broadcasts `analytics.changed` over Socket.IO from HERE (not the
// routes) so it fires for ANY caller — the REST UI, an MCP tool, a background job —
// and all connected clients (tabs) stay in sync live.

import { randomUUID } from 'node:crypto'

const REPORTS = 'whitebox_reports'
const WIDGETS = 'whitebox_widgets'

let db
let connect
export function init(deps) { db = deps.db; connect = deps.connect }

const j = (v) => (v == null ? null : JSON.stringify(v))

// action ∈ report.created | report.updated | report.deleted | widget.added |
//          widget.updated (data changed) | widget.restyled (title/width) | widget.reordered | widget.removed
const live = (report_id, action, widget_id) => {
  try { connect?.broadcast?.('analytics.changed', { report_id, action, widget_id }) }
  catch { /* sockets are best-effort */ }
}

// ── reports ──────────────────────────────────────────────────────────────────
export async function listReports() {
  // newest report on top — by creation, so the order is stable and doesn't shuffle
  // when an existing report is edited (which bumps updated_at). widget_count is the real
  // panel count (a correlated subquery) — `layout` is grid positions and is null until a
  // report is reordered, so it can't be used to count widgets.
  return db(REPORTS)
    .select(`${REPORTS}.*`)
    .select(db.raw(`(select count(*)::int from ${WIDGETS} where ${WIDGETS}.report_id = ${REPORTS}.id) as widget_count`))
    .orderBy('created_at', 'desc')
}

export async function createReport({ name, layout = null }) {
  const [row] = await db(REPORTS)
    .insert({ id: randomUUID(), name, layout: j(layout) })
    .returning('*')
  live(row.id, 'report.created')
  return row
}

export async function getReport(id) {
  const report = await db(REPORTS).where({ id }).first()
  if (!report) return null
  // report.layout (when present) holds the grid-layout-plus positions [{ i, x, y, w, h }],
  // applied client-side. Widget rows come back in insertion order.
  const widgets = await db(WIDGETS).where({ report_id: id }).orderBy('sort')
  return { ...report, widgets }
}

export async function updateReport(id, patch) {
  const fields = { updated_at: db.fn.now() }
  if (patch.name !== undefined) fields.name = patch.name
  if (patch.layout !== undefined) fields.layout = j(patch.layout)
  const [row] = await db(REPORTS).where({ id }).update(fields).returning('*')
  if (row) live(id, 'report.updated')
  return row || null
}

export async function deleteReport(id) {
  const n = await db(REPORTS).where({ id }).del()   // cascades widgets
  if (n) live(id, 'report.deleted')
  return n
}

// ── widgets ──────────────────────────────────────────────────────────────────
export async function getWidget(id) {
  return db(WIDGETS).where({ id }).first()
}

export async function addWidget(reportId, w) {
  const [row] = await db(WIDGETS)
    .insert({
      id: randomUUID(),
      report_id: reportId,
      title: w.title ?? null,
      kind: w.kind,
      query: j(w.query),
      presentation: j(w.presentation),
      position: j(w.position),
      provenance: w.provenance ?? 'human',
      sort: w.sort ?? 0,
      summary: w.summary ?? null,
    })
    .returning('*')
  await touchReport(reportId)
  live(reportId, 'widget.added', row.id)
  return row
}

export async function updateWidget(id, patch) {
  const fields = { updated_at: db.fn.now() }
  for (const k of ['title', 'kind', 'provenance', 'sort']) if (patch[k] !== undefined) fields[k] = patch[k]
  for (const k of ['query', 'presentation', 'position']) if (patch[k] !== undefined) fields[k] = j(patch[k])
  if (patch.summary !== undefined) fields.summary = patch.summary
  else if (patch.query !== undefined) fields.summary = null   // query changed → cached summary is stale
  const [row] = await db(WIDGETS).where({ id }).update(fields).returning('*')
  if (row) {
    await touchReport(row.report_id)
    const keys = Object.keys(patch)
    if (keys.every((k) => k === 'summary')) { /* internal cache write — stay silent */ }
    else if (keys.some((k) => k === 'query' || k === 'kind')) live(row.report_id, 'widget.updated', id)   // data changed → re-resolve
    else live(row.report_id, 'widget.restyled', id)   // title/width/sort only → refresh view, no re-resolve
  }
  return row || null
}

// Reassign sort to match a caller-supplied id order (drag-to-reorder). One
// broadcast for the whole report — restyle, not re-resolve.
export async function reorderWidgets(reportId, orderedIds) {
  await db.transaction(async (trx) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await trx(WIDGETS).where({ id: orderedIds[i], report_id: reportId }).update({ sort: i, updated_at: trx.fn.now() })
    }
  })
  await touchReport(reportId)
  live(reportId, 'widget.reordered')
  return true
}

export async function deleteWidget(id) {
  const row = await db(WIDGETS).where({ id }).first()
  if (!row) return 0
  const n = await db(WIDGETS).where({ id }).del()
  await touchReport(row.report_id)
  live(row.report_id, 'widget.removed', id)
  return n
}

async function touchReport(reportId) {
  await db(REPORTS).where({ id: reportId }).update({ updated_at: db.fn.now() })
}

// ── distribution (histogram source data) ─────────────────────────────────────
// These read RAW numeric values for binning in histogram.js. We deliberately do
// NOT go through the core fact predicate: its comparator parses a numeric string
// ("1820") as a date (operators.toTime → Date.parse), which mis-orders values.
// Reading the value directly and casting in JS (Number) sidesteps that entirely.

// Latest numeric value per passport for a fact `key`, within an optional scope
// (passport-id array). Non-numeric / empty values are dropped.
export async function factValues(key, scope) {
  let q = db('whitebox_facts')
    .distinctOn('passport_id')
    .select('passport_id', 'value')
    .where({ key })
    .orderBy('passport_id')
    .orderBy('observed_at', 'desc')
  if (Array.isArray(scope)) q = q.whereIn('passport_id', scope)
  const rows = await q
  return rows
    .map((r) => (r.value === '' || r.value == null ? NaN : Number(r.value)))
    .filter(Number.isFinite)
}

// Distinct values seen for a fact `key` (the buckets of a fact breakdown), within
// an optional scope. Used when a breakdown groups by a fact but no explicit value
// list was given — e.g. the compose model emits group.by:"fact:client_status".
export async function factDistinctValues(key, scope, limit = 12) {
  let q = db('whitebox_facts').distinct('value').where({ key }).whereNotNull('value').limit(limit)
  if (Array.isArray(scope)) q = q.whereIn('passport_id', scope)
  const rows = await q
  return rows.map((r) => r.value).filter((v) => v != null && v !== '')
}

// Per-passport COUNT of an event (meta.event = `event`), within an optional
// scope. Only people with ≥1 such event have rows, so a count distribution
// naturally starts at 1 (people with zero never appear in the exposures table).
export async function eventCounts(event, scope) {
  let q = db('whitebox_awareness_exposures')
    .select('passport_id')
    .count('* as n')
    .whereRaw("meta->>'event' = ?", [event])
    .groupBy('passport_id')
  if (Array.isArray(scope)) q = q.whereIn('passport_id', scope)
  const rows = await q
  return rows.map((r) => Number(r.n)).filter(Number.isFinite)
}

// ── cohort retention source data ─────────────────────────────────────────────
// One row per (passport, active period) — the periods (month/week, truncated) in
// which each person had activity (optionally of a specific event, within scope).
// The cohort assignment + retention math is done in JS (routes) from these pairs.
export async function cohortRows(event, grain, scope) {
  const trunc = grain === 'week' ? 'week' : 'month'
  let q = db('whitebox_awareness_exposures')
    .distinct('passport_id', db.raw('date_trunc(?, ts) as p', [trunc]))
  if (event) q = q.whereRaw("meta->>'event' = ?", [event])
  if (Array.isArray(scope)) q = q.whereIn('passport_id', scope)
  const rows = await q
  return rows.map((r) => ({ id: r.passport_id, p: new Date(r.p) }))
}

// ── scatter (X/Y source data) ────────────────────────────────────────────────
// Latest value of a fact `key` per passport (optionally scoped) → Map<id, value>.
// Same numeric-string caveat as factValues: read raw, cast at the call site.
async function latestByPassport(key, scope) {
  let q = db('whitebox_facts')
    .distinctOn('passport_id')
    .select('passport_id', 'value')
    .where({ key })
    .orderBy('passport_id')
    .orderBy('observed_at', 'desc')
  if (Array.isArray(scope)) q = q.whereIn('passport_id', scope)
  return new Map((await q).map((r) => [r.passport_id, r.value]))
}

// ── one person (for a selected list row's insight) ───────────────────────────
// Latest value of every fact key for one passport → { key: value }.
// Latest full_name per passport for a page of people — ONE query, so the people-table label
// can prefer a real name (over a masked identity) without an N+1 of personFacts() calls.
export async function namesByPassports(ids = []) {
  if (!ids.length) return {}
  const rows = await db('whitebox_facts')
    .distinctOn('passport_id').select('passport_id', 'value')
    .where('key', 'full_name').whereIn('passport_id', ids)
    .orderBy('passport_id').orderBy('observed_at', 'desc')
  return Object.fromEntries(rows.map((r) => [r.passport_id, r.value]))
}

export async function personFacts(passportId) {
  const rows = await db('whitebox_facts')
    .distinctOn('key').select('key', 'value')
    .where({ passport_id: passportId })
    .orderBy('key').orderBy('observed_at', 'desc')
  return Object.fromEntries(rows.map((r) => [r.key, r.value]))
}

// One person's most recent activity (event + channel + direction + when), newest first.
export async function personActivity(passportId, limit = 6) {
  const rows = await db('whitebox_awareness_exposures')
    .select(db.raw("meta->>'event' as event"), 'channel', 'direction', 'ts')
    .where({ passport_id: passportId })
    .orderBy('ts', 'desc').limit(limit)
  return rows.map((r) => ({ event: r.event, channel: r.channel, direction: r.direction, ts: r.ts }))
}

// Per-passport (x, y) pairs of two NUMERIC facts — the scatter source. Only
// people who have BOTH facts (numeric) appear. `colorBy` adds a categorical
// group per point (its raw value). Capped at `limit` points.
export async function factPairs(xKey, yKey, { scope, colorBy, limit = 2000 } = {}) {
  const [xs, ys, gs] = await Promise.all([
    latestByPassport(xKey, scope),
    latestByPassport(yKey, scope),
    colorBy ? latestByPassport(colorBy, scope) : Promise.resolve(new Map()),
  ])
  const points = []
  for (const [id, yv] of ys) {
    const x = Number(xs.get(id)); const y = Number(yv)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    const p = { id, x, y }
    if (colorBy) p.group = gs.get(id) ?? null
    points.push(p)
    if (points.length >= limit) break
  }
  return points
}
