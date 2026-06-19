import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'

import * as store from './store.js'
import * as memory from './memory.js'
import * as query from './query.js'
import * as askCore from './ask.js'
import createNotify from '../notify.js'
import { redact } from './pii.js'

function hashContent(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

// Follow the passport merge chain so an absorbed (merged-away) id maps to its
// survivor everywhere awareness reads or writes — a stale id never orphans data
// under a tombstone. No-op if passports isn't wired (e.g. unit tests).
async function resolveId(id) {
  return id && passports?.resolve ? passports.resolve(id) : id
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Dependencies / state captured once via init() — module-level singleton, no
// wrapping factory closure. Matches the core pattern (passports, sessions, …).
// notify is a per-consumer factory (per-webhooks config) so it stays a created
// instance held at module level.
let db
let logger
let enabled
let redactPii
let notify
let passports

export function init(deps) {
  db = deps.db
  passports = deps.passports
  logger = deps.logger.child({ component: 'awareness' })
  const cfg = deps.config.awareness || {}
  enabled = cfg.enabled !== false
  redactPii = cfg.pii?.redact !== false

  ;({ notify } = createNotify({ webhooksConfig: cfg.webhooks, events: deps.events, webhooks: deps.webhooks }))

  store.init({ db })
  if (enabled) memory.init({ store, ai: deps.ai, queue: deps.queue, config: deps.config, logger })
  query.init({ store, ai: deps.ai, logger })
  // The reasoning primitives: per-passport (recall + context) and cohort /
  // whole-base (population + base stats + sample) → grounded synthesis.
  askCore.init({ ai: deps.ai, context: deps.context, recall, population, populationStats, sampleContent })
}

export async function migrate() {
  await db.migrate.latest({
    directory: path.join(__dirname, 'migrations'),
    tableName: 'whitebox_awareness_migrations',
  })
}

export async function record(event) {
  if (!enabled) return null
  if (!event.passport_id || !event.text || !event.channel || !event.direction) {
    logger.warn({ event }, 'Awareness record missing required fields')
    return null
  }

  const text = redactPii ? redact(event.text) : event.text
  const content_hash = hashContent(text)

  const exposure = await store.insertExposure({
    passport_id: await resolveId(event.passport_id),
    session_id: event.session_id || null,
    ts: event.ts || new Date(),
    channel: event.channel,
    direction: event.direction,
    source: event.source || null,
    content_id: event.content_id || null,
    content_url: event.content_url || null,
    text,
    content_hash,
    dwell_ms: event.dwell_ms || null,
    meta: event.meta || null,
  })

  memory.enqueue(exposure.id).catch(err => {
    logger.error({ err, exposureId: exposure.id }, 'Failed to enqueue embedding')
  })

  notify('awareness.recorded', {
    type: 'awareness.recorded',
    data: {
      exposure_id: exposure.id,
      passport_id: exposure.passport_id,
      session_id: exposure.session_id,
      ts: exposure.ts,
      channel: exposure.channel,
      direction: exposure.direction,
      source: exposure.source,
      content_id: exposure.content_id,
    },
  }).catch(err => logger.warn({ err }, 'awareness.recorded notify failed'))

  return exposure
}

// Dev/demo reset — wipe all awareness content. Gated by the server's --reset
// flag; not a normal-operation primitive.
export async function reset() {
  if (!enabled) return
  await store.reset()
}

export async function forget({ passport_id }) {
  if (!enabled) return 0
  passport_id = await resolveId(passport_id)
  const deleted = await store.deletePassport(passport_id)

  // GC chunks whose content_hash is no longer referenced by any exposure.
  // Chunks that other passports still reference are preserved (shared content).
  const orphans = await store.gcOrphanChunks().catch(err => {
    logger.warn({ err, passport_id }, 'orphan chunk GC failed')
    return 0
  })

  notify('awareness.forgotten', {
    type: 'awareness.forgotten',
    data: { passport_id, deleted_count: deleted, orphan_chunks_deleted: orphans },
  }).catch(err => logger.warn({ err }, 'awareness.forgotten notify failed'))

  return deleted
}

export async function recall(args) {
  if (!enabled) return []
  return query.recall({ ...args, passport_id: await resolveId(args.passport_id) })
}

export async function population(args) {
  if (!enabled) return { count: 0, passports: [] }
  return query.population(args)
}

export async function populationStats() {
  if (!enabled) return { customers: 0, exposures: 0, breakdown: [] }
  return query.populationStats()
}

export async function sampleContent(args) {
  if (!enabled) return []
  return query.sampleContent(args)
}

export async function timeline(args) {
  if (!enabled) return []
  return store.timeline({ ...args, passport_id: await resolveId(args.passport_id) })
}

export async function ask(args) {
  if (!enabled) return { answer: 'Awareness is disabled.', evidence: [], context: {} }
  return askCore.ask({ ...args, passport_id: await resolveId(args.passport_id) })
}

// Population-scope synthesis — a grounded answer about the whole customer base
// (or a semantic cohort within it), not a single passport.
export async function askPopulation(args) {
  if (!enabled) return { answer: 'Awareness is disabled.', cohort: { count: 0 }, evidence: [] }
  return askCore.askPopulation(args)
}
