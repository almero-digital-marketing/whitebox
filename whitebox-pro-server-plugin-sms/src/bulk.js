import { z } from 'zod'
import crypto from 'crypto'
import * as suppressions from './suppressions.js'
import * as invalid from './invalid.js'
import * as outbox from './outbox.js'
import { toE164 } from './phone.js'

const MAX_RECIPIENTS = 10_000

const recipientSchema = z.object({
  to: z.string().min(3),
  data: z.record(z.any()).optional().nullable(),
})

const bulkSchema = z.object({
  from: z.string().optional().nullable(),
  body: z.string().optional(),
  template: z.string().optional().nullable(),
  media: z.array(z.string().url()).optional(),
  recipients: z.array(recipientSchema).min(1).max(MAX_RECIPIENTS),
}).refine(d => d.body || d.template, { message: 'body or template is required' })

let notify, logger, config

export function init(deps) {
  ;({ notify, logger, config } = deps)
}

const defaultCountry = () => config.sms?.defaultCountry

export async function send({ from, body, template, media, recipients }) {
  const batchId = crypto.randomUUID()

  // Normalize to E.164 + dedupe; drop unparseable numbers.
  const seen = new Set()
  const unique = []
  let duplicates = 0
  let invalidNumbers = 0
  for (const r of recipients) {
    const to = toE164(r.to, defaultCountry())
    if (!to) { invalidNumbers++; continue }
    if (seen.has(to)) { duplicates++; continue }
    seen.add(to)
    unique.push({ to, data: r.data || null })
  }

  const phones = unique.map(r => r.to)
  const [suppressedSet, invalidSet] = await Promise.all([
    suppressions.checkMany(phones),
    invalid.checkMany(phones),
  ])

  const accepted = []
  let skippedSuppressed = 0
  let skippedInvalid = 0
  for (const r of unique) {
    if (invalidSet.has(r.to)) { skippedInvalid++; continue }
    if (suppressedSet.has(r.to)) { skippedSuppressed++; continue }
    accepted.push(r)
  }

  const items = accepted.map(r => ({
    to: r.to, from: from || null, body: body || null, template: template || null,
    media: media || null, batchId, data: r.data,
  }))
  const rows = await outbox.createMany(items)

  // One job per recipient (SMS gateways send per-message; no native batch).
  if (rows.length) {
    const jobs = rows.map(row => ({ name: 'send', data: { id: row.id }, opts: { jobId: String(row.id) } }))
    if (typeof outbox.outboxQueue.addBulk === 'function') await outbox.outboxQueue.addBulk(jobs)
    else for (const j of jobs) await outbox.outboxQueue.add(j.name, j.data, j.opts)
  }

  if (notify) {
    await notify('sms.bulk.queued', { type: 'sms.bulk.queued', data: { batch_id: batchId, accepted: rows.length } }).catch(() => {})
  }

  return {
    batch_id: batchId,
    accepted: rows.length,
    skipped_suppressed: skippedSuppressed,
    skipped_invalid: skippedInvalid,
    invalid_numbers: invalidNumbers,
    duplicates,
  }
}

export async function create(req, res) {
  const parsed = bulkSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
  try {
    res.status(202).json(await send(parsed.data))
  } catch (err) {
    logger.error({ err }, 'Failed to submit bulk sms')
    res.status(500).json({ error: 'Failed to submit bulk sms' })
  }
}

export async function show(req, res) {
  try {
    const stats = await outbox.batchStats(req.params.batchId)
    if (!Object.keys(stats.totals).length) return res.status(404).end()
    res.json(stats)
  } catch (err) {
    logger.error({ err }, 'Failed to fetch sms batch stats')
    res.status(500).json({ error: 'Failed to fetch batch stats' })
  }
}

export async function cancel(req, res) {
  try {
    const result = await outbox.cancelBatch(req.params.batchId)
    if (notify && result.cancelled > 0) {
      await notify('sms.bulk.cancelled', { type: 'sms.bulk.cancelled', data: result }).catch(() => {})
    }
    res.json(result)
  } catch (err) {
    logger.error({ err }, 'Failed to cancel sms batch')
    res.status(500).json({ error: 'Failed to cancel batch' })
  }
}
