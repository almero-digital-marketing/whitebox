#!/usr/bin/env node
// Seed a realistic **beauty-clinic** dataset so anyone can test the analytics UI.
//
// It boots the server core in-process (db · redis · queue · ai · awareness · facts ·
// sessions · selector) — the SAME init sequence as src/server.js — then writes data
// directly through ctx.awareness.record / ctx.facts.record / ctx.passports / sessions.
// Going direct (not over HTTP) is deliberate: it lets us **back-date** events across
// several months and set channel/direction/source precisely.
//
// Data model (see docs/event-attributes.md): acquisition/UTM lives on **sessions**
// (whitebox_sessions columns), each event links to its session via session_id, the
// event's action is `meta.event`, and content_id is an OPAQUE id — never a taxonomy.
// NOTE: the campaign/funnel/event widgets stay BLANK until core ships the `session:`/
// `attr:` metric queries — they currently match on `content_id` substrings, which this
// data no longer carries. Pure-fact reports (status, membership, lapsed) still work.
//
// Scenarios covered: UTM acquisition campaigns (email/social/cpc), marketing email
// sends·opens·clicks, an SMS flash sale, outbound VoIP win-back calls, marketing
// opt-in — plus the booking/treatment/membership lifecycle. It also seeds pre-built
// dashboards (Campaign Performance · Email & SMS Marketing · Retention & Win-back).
//
// Requires the same env as the server (server/.env): WB_DB_*, WB_REDIS_*,
// WB_OPENAI_API_KEY. Run from the server package:
//
//   node --env-file-if-exists=.env scripts/seed-analytics.mjs            # add ~80 clients + reports
//   node --env-file-if-exists=.env scripts/seed-analytics.mjs --reset    # wipe demo data first
//   node --env-file-if-exists=.env scripts/seed-analytics.mjs --count=150
//   node --env-file-if-exists=.env scripts/seed-analytics.mjs --no-reports     # data only, no dashboards
//   node --env-file-if-exists=.env scripts/seed-analytics.mjs --reports-only   # rebuild dashboards only
//
// Facts + awareness exposures are queryable immediately (charts/breakdowns/funnels
// work without embeddings). Semantic `about` / answer widgets need the embed worker
// to finish — embeddings are enqueued on the normal record path and process wherever
// a worker runs (the server, or pass --drain here to wait).

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import '../src/quiet-deprecations.js'
import { load as loadConfig } from '../src/config.js'
import logger, { init as initLogger } from '../src/logger.js'
import * as db from '../src/db.js'
import * as redis from '../src/redis.js'
import * as queue from '../src/queue.js'
import * as events from '../src/events.js'
import * as lock from '../src/lock.js'
import * as webhooks from '../src/webhooks.js'
import * as passports from '../src/passports.js'
import * as sessions from '../src/sessions.js'
import * as ai from '../src/ai.js'
import * as context from '../src/context.js'
import * as awareness from '../src/awareness/index.js'
import * as facts from '../src/facts/index.js'
import * as selector from '../src/selector/index.js'

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const RESET = argv.includes('--reset')
const DRAIN = argv.includes('--drain')
const NO_REPORTS = argv.includes('--no-reports')   // skip seeding the demo dashboards
const REPORTS_ONLY = argv.includes('--reports-only')   // (re)seed only the dashboards, no client data
const COUNT = Number((argv.find(a => a.startsWith('--count=')) || '').split('=')[1] || 80)
const DEMO_DOMAIN = 'beautyclinic.demo'   // marks rows this script owns (for --reset)

// ── deterministic RNG (reproducible demos) ───────────────────────────────────
let _s = 0x9e3779b9
const rnd = () => { _s = (_s * 1664525 + 1013904223) >>> 0; return _s / 0x100000000 }
const pick = arr => arr[Math.floor(rnd() * arr.length)]
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1))
const chance = p => rnd() < p
const DAY = 86_400_000
const daysAgo = d => new Date(Date.now() - d * DAY)

// ── domain vocabulary ─────────────────────────────────────────────────────────
const FIRST = ['Maria', 'Elena', 'Ivana', 'Sofia', 'Anna', 'Petya', 'Gabriela', 'Yana', 'Desislava', 'Kalina', 'Nadia', 'Viktoria', 'Teodora', 'Radost', 'Mila', 'Liam', 'Georgi', 'Stefan', 'Nikolay', 'Daniel']
const LAST = ['Ivanova', 'Petrova', 'Dimitrova', 'Georgieva', 'Stoyanova', 'Koleva', 'Todorova', 'Angelova', 'Marinova', 'Hristova']
const ORGANIC = ['walk-in', 'referral']            // acquisition with no campaign attribution
const TREATMENTS = [
  { key: 'botox', label: 'Botox / anti-wrinkle', price: [180, 420], read: 'How long does Botox last and is it painful — forehead and crow’s-feet treatment details.' },
  { key: 'fillers', label: 'Dermal fillers', price: [250, 600], read: 'Lip and cheek dermal fillers — hyaluronic acid, before and after gallery, recovery time.' },
  { key: 'laser', label: 'Laser hair removal', price: [90, 300], read: 'Laser hair removal course pricing, how many sessions, suitability for skin type.' },
  { key: 'facial', label: 'Signature facial', price: [70, 150], read: 'Hydrating signature facial and chemical-free deep cleanse — what to expect.' },
  { key: 'microneedling', label: 'Microneedling', price: [150, 320], read: 'Microneedling for acne scars and skin texture — collagen induction therapy.' },
  { key: 'peel', label: 'Chemical peel', price: [120, 260], read: 'Chemical peel for pigmentation and dull skin — downtime and aftercare.' },
]

// Marketing campaigns with UTM attribution. Acquisition campaigns (email/social/
// cpc) bring leads in; the SMS flash + newsletters retarget existing clients; the
// win-back campaign is outbound VoIP to lapsed clients. content_id is namespaced
// Each touch is attributed via the SESSION it happened in (whitebox_sessions carries
// the UTM columns); the event's action lives in meta.event. content_id stays opaque.
// See docs/event-attributes.md — no `content_id` taxonomy, no duplicated utm facts.
const CAMPAIGNS = [
  { key: 'spring_botox', name: 'Spring Botox Refresh', channel: 'mail', medium: 'email',  source: 'newsletter', utm: 'spring_botox_2026', treatment: 'botox' },
  { key: 'summer_laser', name: 'Summer Laser Package', channel: 'mail', medium: 'email',  source: 'newsletter', utm: 'summer_laser_2026', treatment: 'laser' },
  { key: 'fillers_ig',   name: 'Instagram Fillers',    channel: 'web',  medium: 'social', source: 'instagram',  utm: 'fillers_ig_q2',   treatment: 'fillers' },
  { key: 'brand_search', name: 'Google Brand Search',  channel: 'web',  medium: 'cpc',    source: 'google',     utm: 'brand_search',    treatment: null },
  { key: 'flash_sms',    name: 'Flash SMS Sale',        channel: 'sms',  medium: 'sms',    source: 'promo',      utm: 'flash_sale_sms',  treatment: 'facial' },
]
const ACQ_CAMPAIGNS = CAMPAIGNS.filter(c => ['email', 'social', 'cpc'].includes(c.medium))  // bring leads in
const NEWSLETTERS   = CAMPAIGNS.filter(c => c.medium === 'email')                            // retarget existing clients
const FLASH_SMS     = CAMPAIGNS.find(c => c.key === 'flash_sms')
const WINBACK       = { key: 'winback_q2', name: 'Win-back Calls', channel: 'voip', medium: 'call', source: 'outbound', utm: 'winback_q2' }

const rec = (passport_id, e) => awareness.record({ passport_id, ...e })
const fct = (passport_id, key, value, observed_at, extra = {}) =>
  facts.record({ passport_id, key, value, source: 'seed', observed_at, ...extra })

// Record one event. The ACTION is `meta.event`; per-event dims go in `meta`; the
// campaign/acquisition context is the SESSION (`session_id` → whitebox_sessions, which
// carries the UTM columns). content_id is NOT set — it's untrusted user garbage the
// system never reads; we don't fabricate ids for it. See docs/event-attributes.md.
const ev = (pid, { text, channel, direction, source, event, day, session_id = null, content_id = null, dwell_ms, meta = {} }) =>
  rec(pid, {
    text, channel, direction, source, content_id, session_id, dwell_ms,
    ts: daysAgo(Math.max(0, day)), meta: { event, ...meta },
  })

// A marketing email send → maybe opened → maybe clicked, all in the campaign's session.
async function emailBlast(pid, c, sid, day, openP = 0.5, clickP = 0.35) {
  await ev(pid, { text: `${c.name} — email.`, channel: 'mail', direction: 'exposure', source: c.source, event: 'email_sent', day, session_id: sid })
  if (!chance(openP)) return
  await ev(pid, { text: `${c.name} — opened.`, channel: 'mail', direction: 'exposure', source: c.source, event: 'email_open', day, session_id: sid })
  if (chance(clickP)) await ev(pid, { text: `${c.name} — link clicked.`, channel: 'mail', direction: 'expression', source: c.source, event: 'email_click', day, session_id: sid })
}

// One client's whole journey, coherent with an archetype.
async function seedClient(i) {
  const first = pick(FIRST), last = pick(LAST)
  const name = `${first} ${last}`
  const email = `${first}.${last}.${i}@${DEMO_DOMAIN}`.toLowerCase()
  const phone = `+3598${int(10, 99)}${String(100000 + i).slice(-6)}`
  // archetype mix: lead 35% · active 40% · lapsed 15% · vip 10%
  const r = rnd()
  const archetype = r < 0.35 ? 'lead' : r < 0.75 ? 'active' : r < 0.90 ? 'lapsed' : 'vip'
  const fav = pick(TREATMENTS)

  // acquisition — ~70% via a UTM campaign (email/social/cpc), the rest organic
  const acq = chance(0.7) ? pick(ACQ_CAMPAIGNS) : null
  const organicSource = acq ? null : pick(ORGANIC)   // walk-in / referral
  const optIn = chance(0.82)                          // consented to marketing email/SMS

  const pid = await passports.identify(null)
  await passports.link(pid, [
    { type: 'email', name: 'primary', value: email },
    { type: 'phone', name: 'e164', value: phone },
  ])

  // Sessions are the home for acquisition/UTM. One session per campaign context,
  // cached per client; events link to it via session_id. (docs/event-attributes.md)
  const sessionCache = {}
  const sessionFor = async (camp) => {
    const key = camp ? camp.key : `organic:${organicSource}`
    if (sessionCache[key]) return sessionCache[key]
    const utms = camp
      ? { utm_source: camp.source, utm_medium: camp.medium, utm_campaign: camp.utm }
      : { utm_source: organicSource }
    const s = await sessions.start(pid, utms)
    sessionCache[key] = s.id
    return s.id
  }

  // first touch — earlier for established clients
  const firstSeen = archetype === 'lead' ? int(2, 60)
    : archetype === 'active' ? int(40, 200)
    : archetype === 'lapsed' ? int(200, 300)
    : int(120, 320)
  const acqSession = await sessionFor(acq)   // campaign UTM, or organic source — the first touch

  // facts — per-passport state only; acquisition/UTM lives on the session now
  await fct(pid, 'full_name', name, daysAgo(firstSeen))
  await fct(pid, 'client_status', 'lead', daysAgo(firstSeen))
  await fct(pid, 'preferred_treatment', fav.key, daysAgo(firstSeen))
  await fct(pid, 'marketing_opt_in', optIn ? 'yes' : 'no', daysAgo(firstSeen))

  // entry event on the acquiring channel (in the acquisition session)
  if (acq) {
    if (acq.medium === 'email') await emailBlast(pid, acq, acqSession, firstSeen, 1, 0.7)   // opened — it converted them
    else await ev(pid, { text: `${acq.name} — ad click.`, channel: 'web', direction: 'exposure', source: acq.source, event: 'ad_click', day: firstSeen, session_id: acqSession, dwell_ms: int(15, 120) * 1000 })
  }

  // ── discovery: web reading + maybe a consultation form / phone call ──
  const reads = int(1, 4)
  for (let k = 0; k < reads; k++) {
    const t = chance(0.7) ? fav : pick(TREATMENTS)
    await ev(pid, { text: t.read, channel: 'web', direction: 'exposure', source: 'page', event: 'page_view', day: firstSeen - int(0, 3), session_id: acqSession, dwell_ms: int(8, 140) * 1000, meta: { treatment: t.key } })
  }
  if (chance(0.6)) await ev(pid, { text: 'Pricing and package options for facial aesthetics treatments.', channel: 'web', direction: 'exposure', source: 'page', event: 'page_view', day: firstSeen - 1, session_id: acqSession, dwell_ms: int(20, 90) * 1000, meta: { page: 'pricing' } })
  const requestedConsult = archetype !== 'lead' || chance(0.5)
  if (requestedConsult) await ev(pid, { text: `Consultation request for ${fav.label.toLowerCase()}. Asked about price and downtime.`, channel: 'web', direction: 'expression', source: 'form', event: 'form_submit', day: firstSeen - 3, session_id: acqSession, meta: { form: 'consultation' } })
  if (chance(0.4)) await ev(pid, { text: `Phone consultation. Discussed ${fav.label.toLowerCase()}, suitability and aftercare. Friendly, a little price-sensitive.`, channel: 'voip', direction: 'conversation', source: 'call', event: 'call', day: firstSeen - 4, dwell_ms: int(4, 18) * 60 * 1000, meta: { topic: 'consultation' } })

  // ── ongoing marketing: newsletters + an SMS flash sale to opted-in clients ────
  if (optIn) {
    const sends = archetype === 'vip' ? int(4, 7) : archetype === 'active' ? int(3, 5)
      : archetype === 'lapsed' ? int(2, 4) : int(1, 2)
    for (let s = 0; s < sends; s++) {
      const camp = pick(NEWSLETTERS)
      await emailBlast(pid, camp, await sessionFor(camp), int(1, Math.max(2, firstSeen)))
    }
    if (chance(0.5)) {
      const day = int(1, Math.max(2, firstSeen))
      const sid = await sessionFor(FLASH_SMS)
      await ev(pid, { text: `${FLASH_SMS.name} — SMS.`, channel: 'sms', direction: 'exposure', source: FLASH_SMS.source, event: 'sms_sent', day, session_id: sid })
      if (chance(0.25)) await ev(pid, { text: `${FLASH_SMS.name} — link clicked.`, channel: 'sms', direction: 'expression', source: FLASH_SMS.source, event: 'sms_click', day, session_id: sid })
    }
  }

  // ── conversion path by archetype ────────────────────────────────────────────
  let ltv = 0
  const bookings = archetype === 'lead' ? 0
    : archetype === 'active' ? int(1, 4)
    : archetype === 'lapsed' ? int(1, 2)
    : int(5, 12)               // vip

  if (bookings > 0) {
    // status lead → active at first booking
    const firstBookingDay = Math.max(1, firstSeen - int(4, 10))
    await fct(pid, 'client_status', 'active', daysAgo(firstBookingDay))
    let day = firstBookingDay
    for (let b = 0; b < bookings; b++) {
      const t = chance(0.65) ? fav : pick(TREATMENTS)
      const price = int(t.price[0], t.price[1])
      ltv += price
      // SMS reminder before each visit, then the booking (a conversion w/ value)
      await ev(pid, { text: `Reminder: your ${t.label.toLowerCase()} appointment is tomorrow at the clinic.`, channel: 'sms', direction: 'exposure', source: 'reminder', event: 'sms_reminder', day: day + 1 })
      await ev(pid, { text: `Booked and completed ${t.label.toLowerCase()}.`, channel: 'crm', direction: 'conversion', source: 'booking', event: 'booking', day, meta: { value: price, currency: 'BGN', treatment: t.key } })
      await fct(pid, 'last_treatment', t.key, daysAgo(day))
      await fct(pid, 'last_treatment_at', daysAgo(day).toISOString().slice(0, 10), daysAgo(day))
      day = Math.max(1, day - int(20, 70))   // visits spaced out, walking toward today
    }
    await fct(pid, 'lifetime_value', ltv, daysAgo(day))
    await fct(pid, 'visits_count', bookings, daysAgo(day))

    // membership: vips gold, frequent actives silver
    const membership = archetype === 'vip' ? 'gold' : bookings >= 3 ? 'silver' : 'none'
    if (membership !== 'none') await fct(pid, 'membership', membership, daysAgo(firstBookingDay - 1))

    // lapsed clients churned: active → lapsed, last visit long ago, no future appt
    if (archetype === 'lapsed') {
      await fct(pid, 'client_status', 'lapsed', daysAgo(int(60, 150)))
      // outbound win-back calls (the win-back campaign session) — some answered, some missed
      const sid = await sessionFor(WINBACK)
      for (let c = 0, n = int(1, 3); c < n; c++) {
        const answered = chance(0.5)
        await ev(pid, { text: `${WINBACK.name} — outbound call (${answered ? 'answered' : 'missed'}).`, channel: 'voip', direction: 'conversation', source: WINBACK.source, event: 'call_outbound', day: int(5, 90), session_id: sid, dwell_ms: answered ? int(3, 12) * 60 * 1000 : 0, meta: { outcome: answered ? 'answered' : 'missed' } })
      }
    } else if (chance(0.6)) {
      // active/vip with an upcoming appointment (enables next/before date queries)
      await fct(pid, 'next_appointment_at', daysAgo(-int(2, 45)).toISOString().slice(0, 10), daysAgo(int(1, 20)))
    }
  } else {
    // a lead who never booked — maybe a future consultation on the calendar
    if (chance(0.3)) await fct(pid, 'next_appointment_at', daysAgo(-int(1, 21)).toISOString().slice(0, 10), daysAgo(int(0, 5)))
  }

  return { pid, archetype }
}

async function resetDemo() {
  const ids = await db.get()('whitebox_passports_identities')
    .where('value', 'like', `%@${DEMO_DOMAIN}`).distinct('passport_id').pluck('passport_id')
  if (!ids.length) { logger.info('reset: no demo data found'); return }
  for (const pid of ids) await awareness.forget({ passport_id: pid }).catch(() => {})
  await db.get()('whitebox_facts').whereIn('passport_id', ids).del().catch(() => {})
  await db.get()('whitebox_sessions').whereIn('passport_id', ids).del().catch(() => {})   // before passports (FK)
  await db.get()('whitebox_passports').whereIn('id', ids).del().catch(() => {})  // cascades identities
  logger.warn('reset: removed %d demo clients', ids.length)
}

// ── advanced reports — pre-built dashboards over the new event model ───────────
// Written through the analytics composition store (the same rows the UI/MCP create),
// so they show up live. Idempotent: any existing report sharing a seeded NAME is
// replaced. Queries slice by the typed homes (docs/event-attributes.md): session UTM
// (`session:`), per-event action (`attrs:{event}`), exposure columns, and facts.
const ACQ_UTMS = ACQ_CAMPAIGNS.map(c => c.utm)   // campaign utm_campaign values
const SOURCES = ['newsletter', 'instagram', 'google', 'promo', 'outbound', 'walk-in', 'referral']
const REPORT_DEFS = [
  ['Campaign Performance', [
    { title: 'Reached by a campaign', kind: 'stat', query: { selector: { filter: { metric: { session: { utm_campaign: ACQ_UTMS }, count: { gte: 1 } } } }, projection: 'people' } },
    { title: 'Opted in to marketing', kind: 'stat', query: { selector: { filter: { fact: { marketing_opt_in: { eq: 'yes' } } } }, projection: 'people' } },
    // KPI: count as progress toward a goal
    { title: 'Campaign reach vs goal', kind: 'stat', query: { selector: { filter: { metric: { session: { utm_campaign: ACQ_UTMS }, count: { gte: 1 } } } }, projection: 'people', target: 120 } },
    { title: 'Clients by campaign', kind: 'breakdown', query: { selector: { filter: { metric: { session: { utm_campaign: ACQ_UTMS }, distinct_passports: {} } } }, group: { by: 'session:utm_campaign' } } },
    { title: 'Clients by source', kind: 'breakdown', query: { selector: { filter: { metric: { session: { utm_source: SOURCES }, distinct_passports: {} } } }, group: { by: 'session:utm_source' } } },
    { title: 'Events by channel', kind: 'breakdown', query: { selector: { filter: { metric: { count: {} } } }, group: { by: 'channel' } } },
    { title: 'Most engaged clients', kind: 'table', query: { selector: { filter: { metric: { attrs: { event: 'email_open' }, count: { gte: 3 } } } }, projection: 'people' } },
  ]],
  ['Email & SMS Marketing', [
    { title: 'Email opens per week', kind: 'timeseries', query: { selector: { filter: { metric: { attrs: { event: 'email_open' }, count: {} } } }, projection: 'knowledge', group: { by: 'week' } } },
    { title: 'Link clicks per week', kind: 'timeseries', query: { selector: { filter: { metric: { attrs: { event: { in: ['email_click', 'sms_click'] } }, count: {} } } }, projection: 'knowledge', group: { by: 'week' } } },
    { title: 'Clients who clicked a link', kind: 'stat', query: { selector: { filter: { metric: { attrs: { event: { in: ['email_click', 'sms_click'] } }, count: { gte: 1 } } } }, projection: 'people' } },
    { title: 'SMS flash-sale reach', kind: 'stat', query: { selector: { filter: { metric: { session: { utm_campaign: 'flash_sale_sms' }, count: { gte: 1 } } } }, projection: 'people' } },
    // a profile across touchpoints: people reached on each channel, drawn as a polygon
    { title: 'Reach by channel', kind: 'radar', query: { selector: { filter: { metric: { distinct_passports: {} } } }, group: { by: 'channel' } } },
    // compare (overlaid radar): channel reach profile, gold vs silver members
    { title: 'Reach by channel: gold vs silver', kind: 'radar', query: { selector: { filter: { metric: { distinct_passports: {} } } }, group: { by: 'channel' }, splitBy: { key: 'membership', values: ['gold', 'silver'] } } },
    { title: 'Email funnel: sent → opened → clicked → booked', kind: 'funnel', query: { funnel: { steps: [
      { name: 'Received', select: { filter: { metric: { attrs: { event: 'email_sent' }, count: { gte: 1 } } } } },
      { name: 'Opened', select: { filter: { metric: { attrs: { event: 'email_open' }, count: { gte: 1 } } } } },
      { name: 'Clicked', select: { filter: { metric: { attrs: { event: 'email_click' }, count: { gte: 1 } } } } },
      { name: 'Booked', select: { filter: { metric: { attrs: { event: 'booking' }, count: { gte: 1 } } } } },
    ] } } },
  ]],
  ['Retention & Win-back', [
    { title: 'Lapsed clients', kind: 'stat', query: { selector: { filter: { fact: { client_status: { eq: 'lapsed' } } } }, projection: 'people' } },
    { title: 'Reached by win-back calls', kind: 'stat', query: { selector: { filter: { metric: { attrs: { event: 'call_outbound' }, count: { gte: 1 } } } }, projection: 'people' } },
    // share-of-total: where the base sits in the lifecycle (donut = a breakdown drawn as a ring)
    { title: 'Client lifecycle mix', kind: 'donut', query: { breakdownFact: { key: 'client_status', values: ['lead', 'active', 'lapsed'] } } },
    // histogram: how customer value spreads across people (auto-binned numeric fact)
    { title: 'Lifetime value spread', kind: 'distribution', query: { distribution: { source: 'fact', key: 'lifetime_value' } } },
    // scatter: the relationship between two numbers — visits vs value, tinted by lifecycle
    { title: 'Value vs visits', kind: 'scatter', query: { scatter: { x: 'visits_count', y: 'lifetime_value', colorBy: 'client_status' } } },
    // compare (grouped bars): the same treatment breakdown, split active vs lapsed
    { title: 'Treatment mix: active vs lapsed', kind: 'breakdown', query: { selector: { filter: { metric: { attrs: { treatment: { present: true } }, distinct_passports: {} } } }, group: { by: 'attr:treatment' }, splitBy: { key: 'client_status', values: ['active', 'lapsed'] } } },
    // 100%-stacked bars: treatment share within each status
    { title: 'Treatment share by status', kind: 'breakdown', query: { selector: { filter: { metric: { attrs: { treatment: { present: true } }, distinct_passports: {} } } }, group: { by: 'attr:treatment' }, splitBy: { key: 'client_status', values: ['lead', 'active', 'lapsed'] }, stack: 'pct' } },
    // 2-D heatmap: treatment (rows) × membership (columns), colour = clients
    { title: 'Treatment × membership', kind: 'heatmap', query: { selector: { filter: { metric: { attrs: { treatment: { present: true } }, distinct_passports: {} } } }, group: { by: 'attr:treatment' }, splitBy: { key: 'membership', values: ['gold', 'silver'] } } },
    // 2-D pivot table: treatment (rows) × lifecycle status (columns)
    { title: 'Treatment × status', kind: 'pivot', query: { selector: { filter: { metric: { attrs: { treatment: { present: true } }, distinct_passports: {} } } }, group: { by: 'attr:treatment' }, splitBy: { key: 'client_status', values: ['lead', 'active', 'lapsed'] } } },
    // cohort retention: bookings by first-booking month, % active over the next months
    { title: 'Booking retention by month', kind: 'cohort', query: { cohort: { event: 'booking', grain: 'month', periods: 5 } } },
    { title: 'Clients by membership', kind: 'breakdown', query: { breakdownFact: { key: 'membership', values: ['gold', 'silver'] } } },
    { title: 'Lapsed client list', kind: 'table', query: { selector: { filter: { fact: { client_status: { eq: 'lapsed' } } } }, projection: 'people' } },
  ]],
]

// Same per-kind sizes as the board's grid defaults (12-col), flowed left→right.
const WIDGET_SIZE = { stat: { w: 4, h: 7 }, timeseries: { w: 6, h: 15 }, breakdown: { w: 4, h: 15 }, donut: { w: 4, h: 15 }, radar: { w: 5, h: 16 }, distribution: { w: 6, h: 15 }, scatter: { w: 6, h: 16 }, funnel: { w: 6, h: 15 }, table: { w: 5, h: 15 }, answer: { w: 5, h: 17 } }

async function seedReports() {
  let store
  try {
    store = await import('../../server-plugin-analytics/src/composition/store.js')
  } catch (err) {
    logger.warn('Report seeding skipped (analytics plugin not found): %s', err.message)
    return
  }
  // ensure the report/widget tables exist (run the plugin's own migrations)
  const migDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server-plugin-analytics/src/migrations')
  await db.get().migrate.latest({ directory: migDir, tableName: 'whitebox_analytics_migrations', loadExtensions: ['.js'] })
  store.init({ db: db.get(), connect: null })   // no sockets in the seeder; broadcasts are best-effort

  // idempotent — replace any existing report that shares a seeded title
  const titles = new Set(REPORT_DEFS.map(([name]) => name))
  for (const r of await store.listReports()) if (titles.has(r.name)) await store.deleteReport(r.id)

  for (const [name, widgets] of REPORT_DEFS) {
    const report = await store.createReport({ name })
    const layout = []
    let x = 0, y = 0, rowH = 0
    for (let k = 0; k < widgets.length; k++) {
      const row = await store.addWidget(report.id, { ...widgets[k], provenance: 'human', sort: k })
      const s = WIDGET_SIZE[widgets[k].kind] || { w: 4, h: 15 }
      if (x + s.w > 12) { x = 0; y += rowH; rowH = 0 }
      layout.push({ i: row.id, x, y, w: s.w, h: s.h })
      x += s.w; rowH = Math.max(rowH, s.h)
    }
    await store.updateReport(report.id, { layout })
  }
  logger.info('Seeded %d advanced reports: %s', REPORT_DEFS.length, REPORT_DEFS.map(([n]) => n).join(' · '))
}

async function boot() {
  const config = await loadConfig({ argv: process.argv, env: process.env })
  initLogger({ config })
  await db.init({ config })
  await redis.init({ config })
  queue.init({ config })
  await events.init({ config })
  lock.init({ redis: redis.get() })
  webhooks.init({ queue, config })
  await passports.init({ db: db.get(), lock, config })
  await sessions.init({ db: db.get(), passports })
  await ai.init({ config })
  context.init({ logger })
  awareness.init({ db: db.get(), queue, ai, events, webhooks, config, logger, context, passports })
  await awareness.migrate()
  facts.init({ db: db.get(), passports, logger, config })
  await facts.migrate()
  selector.init({ db: db.get(), passports, logger, awareness, ai, config })
}

async function main() {
  await boot()

  // --reports-only: just (re)build the demo dashboards against existing data
  if (REPORTS_ONLY) {
    await seedReports()
  } else {
    if (RESET) await resetDemo()

    logger.info('Seeding %d beauty-clinic clients…', COUNT)
    const tally = { lead: 0, active: 0, lapsed: 0, vip: 0 }
    for (let i = 0; i < COUNT; i++) {
      const { archetype } = await seedClient(i)
      tally[archetype]++
      if ((i + 1) % 20 === 0) logger.info('  …%d/%d', i + 1, COUNT)
    }
    logger.info('Seeded clients by archetype: %o', tally)

    // sanity — prove the data is queryable through the selector engine
    const active = await selector.resolve(
      { filter: { fact: { client_status: { eq: 'active' } } } }, { projection: 'people' })
    const exposures = await db.get()('whitebox_awareness_exposures').count('* as n').first()
    logger.info('Sanity: %d active clients (people query) · %s awareness exposures', active.count, exposures.n)

    if (!NO_REPORTS) await seedReports()

    if (DRAIN) {
      logger.info('Waiting for embeddings to drain (--drain)…')
      // best-effort: let in-process embed workers chew through the queue
      await new Promise(r => setTimeout(r, 5000))
    }
  }

  await queue.close().catch(() => {})
  await db.get().destroy().catch(() => {})
  redis.get()?.disconnect?.()
  logger.info('Seed complete.')
  process.exit(0)
}

main().catch(err => { logger.fatal({ err }, 'Seed failed'); process.exit(1) })
