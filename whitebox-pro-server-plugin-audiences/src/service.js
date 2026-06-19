// Service layer — the single implementation REST and MCP both call. No transport
// concerns here. See docs/09-api.md.

import { validate, toRow, fromRow } from './rules.js'

let store, rules, evaluator, delivery, adapters, identity, consent, logger
let evalQueue

export function init(deps) {
  ({ store, rules, evaluator, delivery, adapters, identity, consent, logger } = deps)
}

// --- rules ---
export const listRules = async () => (await store.listRules()).map(fromRow)
export const getRule = async id => fromRow(await store.getRule(id))
export async function saveRule(input, updatedBy) {
  const rule = validate(input)
  await store.upsertRule(toRow(rule, updatedBy))
  return rule
}
export const deleteRule = id => store.deleteRule(id)
export async function setEnabled(id, enabled) {
  const rule = await getRule(id)
  if (!rule) { const e = new Error('rule not found'); e.status = 404; throw e }
  rule.enabled = enabled
  return saveRule(rule)
}

export const draft = description => evaluator.draftRule(description)

// preview accepts a full rule input OR an existing rule id
export async function preview(input, { sample = 50 } = {}) {
  const rule = typeof input === 'string' ? await getRule(input) : validate(input)
  if (!rule) { const e = new Error('rule not found'); e.status = 404; throw e }
  return evaluator.preview(rule, { sample })
}

// --- evaluation + delivery ---
export async function evaluateRule(id, { dryRun = false, limit = 5000 } = {}) {
  const rule = await getRule(id)
  if (!rule) { const e = new Error('rule not found'); e.status = 404; throw e }
  const cand = [...await evaluator.candidates(rule)].slice(0, limit)
  let matched = 0, fired = 0, suppressed = 0
  for (const pid of cand) {
    const v = await evaluator.evaluate(rule, pid)
    await store.upsertMatch({
      rule_id: rule.id, passport_id: pid, qualified: v.qualified,
      score: v.score, reason: v.reason, evidence: JSON.stringify(v.evidence || {}),
      first_matched_at: v.qualified ? new Date().toISOString() : null,
    })
    if (!v.qualified) continue
    matched++
    const r = await delivery.fireMatch(rule, pid, v, { dryRun })
    if (r.skipped) suppressed++
    else if (Object.values(r.fired).some(Boolean)) fired++
  }
  return { evaluated: cand.length, matched, fired, suppressed, dryRun }
}

export async function evaluatePassport(passportId) {
  const enabled = (await store.enabledRules()).map(fromRow)
  const out = []
  for (const rule of enabled) {
    const v = await evaluator.evaluate(rule, passportId)
    await store.upsertMatch({ rule_id: rule.id, passport_id: passportId, qualified: v.qualified, score: v.score, reason: v.reason, evidence: JSON.stringify(v.evidence || {}) })
    if (v.qualified) await delivery.fireMatch(rule, passportId, v)
    out.push({ rule_id: rule.id, qualified: v.qualified, score: v.score })
  }
  return out
}

// --- inspection ---
export async function members(ruleId, { limit = 50, offset = 0 } = {}) {
  const count = Number((await store.ruleMatchCount(ruleId)).n)
  const sample = await store.ruleMatches(ruleId, { limit, offset })
  return { count, sample: sample.map(m => ({ passport_id: m.passport_id, score: m.score, reason: m.reason, last_fired_at: m.last_fired_at })) }
}
export async function stats(ruleId) {
  const qualified = Number((await store.ruleMatchCount(ruleId, true)).n)
  return { rule_id: ruleId, qualified }
}
export async function explain(ruleId, passportId) {
  const m = await store.getMatch(ruleId, passportId)
  if (!m) return null
  return {
    score: m.score, qualified: m.qualified, reason: m.reason,
    evidence: typeof m.evidence === 'string' ? JSON.parse(m.evidence) : m.evidence,
    fired: typeof m.fired === 'string' ? JSON.parse(m.fired) : m.fired,
  }
}
export const passportSegments = async passportId =>
  (await store.passportMatches(passportId)).map(m => ({ rule_id: m.rule_id, score: m.score, last_fired_at: m.last_fired_at }))

// --- networks / identity / facts ---
export const networks = () => adapters.map(a => ({ name: a.name, modes: a.modes, eligible: a.eligible, transport: a.transport || 'http' }))
export const manifest = () => identity.manifest(adapters)
export const availableFacts = () => evaluator.availableFacts()
export const saveSignals = (passportId, signals) => identity.saveSignals(passportId, signals)

// --- deliveries / suppression ---
export const deliveries = filter => store.listDeliveries(filter)
export const suppress = (passportId, reason) => store.suppress(passportId, reason)
export const unsuppress = passportId => store.unsuppress(passportId)
export const listSuppression = () => store.listSuppression()

// --- dirty-tracking + workers ---
export async function markDirty(passportId) {
  if (!evalQueue || !passportId) return
  // jobId = passport ⇒ a re-fired dirty event coalesces into one debounced job.
  await evalQueue.add('eval', { passport_id: passportId }, {
    jobId: `eval:${passportId}`,
    delay: 30_000,
    removeOnComplete: true, removeOnFail: true,
  })
}

export function startWorkers({ queue, scheduler }) {
  if (!queue) return
  evalQueue = queue.createQueue('audiences-eval')
  queue.createWorker('audiences-eval', async job => evaluatePassport(job.data.passport_id))

  // keep-warm: re-fire still-qualifying matches before the platform window ages
  // them out. Wire to your scheduler's cron; see docs/10-deployment.md.
  if (scheduler?.every) {
    scheduler.every('1d', () => keepWarmSweep().catch(err => logger?.warn?.({ err }, 'keep-warm failed')))
  }
}

export async function keepWarmSweep() {
  const enabled = (await store.enabledRules()).map(fromRow)
  for (const rule of enabled) {
    const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString() // re-fire if older than 7d
    const due = await store.dueForRefire(rule.id, cutoff)
    for (const m of due) {
      const v = await evaluator.evaluate(rule, m.passport_id) // re-confirm still qualifies
      if (v.qualified) await delivery.fireMatch(rule, m.passport_id, v)
      else await store.upsertMatch({ rule_id: rule.id, passport_id: m.passport_id, qualified: false, reason: v.reason })
    }
  }
}
