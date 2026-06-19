import { z } from 'zod'
import crypto from 'crypto'
import * as suppressions from './suppressions.js'
import * as invalid from './invalid.js'
import * as outbox from './outbox.js'
import * as attachments from './attachments.js'

const MAX_RECIPIENTS_PER_BATCH = 10_000
const DEFAULT_BATCH_SIZE = 500

const recipientSchema = z.object({
  to: z.string().email(),
  data: z.record(z.any()).optional().nullable(),
})

const bulkSchema = z.object({
  subject: z.string().min(1),
  from: z.string().email().optional().nullable(),
  html: z.string().optional(),
  text: z.string().optional(),
  template: z.string().optional().nullable(),
  attachment_urls: z.array(z.string().url()).optional(),
  recipients: z.array(recipientSchema).min(1).max(MAX_RECIPIENTS_PER_BATCH),
}).refine(d => d.html || d.text || d.template, {
  message: 'At least one of html, text, or template is required',
})

function normalize(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : null
}

// Dependencies captured once via init() — module-level singletons, no
// wrapping factory closure. Matches the core pattern.
let notify
let logger
let provider

export function init(deps) {
  ;({ notify, logger, provider } = deps)
}

// One BullMQ job per chunk of rows (≤ the provider's max batch size). The worker
// turns each into a single provider.sendBatch call. jobId is stable per chunk so
// it stays idempotent on re-submit.
function chunkJobs(rows, batchId, size) {
  const jobs = []
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size)
    jobs.push({ name: 'batch', data: { batchId, ids: chunk.map(r => r.id) }, opts: { jobId: `${batchId}-c${i / size}` } })
  }
  return jobs
}

export async function send({ subject, from, html, text, template, attachment_urls: attachmentUrls, recipients }) {
  const batchId = crypto.randomUUID()

  // Dedupe by normalized email — preserve first occurrence (with its data)
  const seen = new Set()
  const unique = []
  let duplicates = 0
  for (const r of recipients) {
    const key = normalize(r.to)
    if (!key) continue
    if (seen.has(key)) { duplicates++; continue }
    seen.add(key)
    unique.push({ to: key, data: r.data || null })
  }

  // Pre-filter against suppressions + invalid lists
  const emails = unique.map(r => r.to)
  const [suppressedSet, invalidSet] = await Promise.all([
    suppressions.checkMany(emails),
    invalid.checkMany(emails),
  ])

  const accepted = []
  let skippedSuppressed = 0
  let skippedInvalid = 0
  for (const r of unique) {
    if (invalidSet.has(r.to)) { skippedInvalid++; continue }
    if (suppressedSet.has(r.to)) { skippedSuppressed++; continue }
    accepted.push(r)
  }

  // Resolve URL attachments once for the whole batch
  let resolvedAttachments = null
  if (attachmentUrls?.length) {
    const saved = await Promise.all(
      attachmentUrls.map(url => attachments.saveUrl(url).catch(err => {
        logger.warn({ err }, 'Failed to fetch bulk attachment URL: %s', url)
        return null
      }))
    )
    const filtered = saved.filter(Boolean)
    resolvedAttachments = filtered.length ? filtered : null
  }

  // Bulk-insert all outbox rows
  const items = accepted.map(r => ({
    to: r.to,
    subject,
    from: from || null,
    html: html || null,
    text: text || null,
    template: template || null,
    attachments: resolvedAttachments,
    batchId,
    data: r.data,
  }))

  const rows = await outbox.createMany(items)

  // Enqueue jobs. When the provider supports native batch send, group rows into
  // chunk jobs (one provider call each); otherwise fall back to one job per row
  // (jobId = row.id, so a job can be targeted for removal on cancel).
  if (rows.length) {
    const jobs = (typeof provider?.sendBatch === 'function')
      ? chunkJobs(rows, batchId, Math.max(1, provider.maxBatchSize || DEFAULT_BATCH_SIZE))
      : rows.map(row => ({ name: 'send', data: { id: row.id }, opts: { jobId: String(row.id) } }))

    if (typeof outbox.outboxQueue.addBulk === 'function') {
      await outbox.outboxQueue.addBulk(jobs)
    } else {
      for (const j of jobs) await outbox.outboxQueue.add(j.name, j.data, j.opts)
    }
  }

  if (notify) {
    await notify('mail.bulk.queued', { type: 'mail.bulk.queued', data: { batch_id: batchId, accepted: rows.length } }).catch(() => {})
  }

  return {
    batch_id: batchId,
    accepted: rows.length,
    skipped_suppressed: skippedSuppressed,
    skipped_invalid: skippedInvalid,
    duplicates,
  }
}

export async function create(req, res) {
  const parsed = bulkSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

  try {
    const result = await send(parsed.data)
    res.status(202).json(result)
  } catch (err) {
    logger.error({ err }, 'Failed to submit bulk send')
    res.status(500).json({ error: 'Failed to submit bulk send' })
  }
}

export async function show(req, res) {
  try {
    const stats = await outbox.batchStats(req.params.batchId)
    if (!Object.keys(stats.totals).length) return res.status(404).end()
    res.json(stats)
  } catch (err) {
    logger.error({ err }, 'Failed to fetch batch stats')
    res.status(500).json({ error: 'Failed to fetch batch stats' })
  }
}

export async function cancel(req, res) {
  try {
    const result = await outbox.cancelBatch(req.params.batchId)
    if (notify && result.cancelled > 0) {
      await notify('mail.bulk.cancelled', { type: 'mail.bulk.cancelled', data: result }).catch(() => {})
    }
    res.json(result)
  } catch (err) {
    logger.error({ err }, 'Failed to cancel batch')
    res.status(500).json({ error: 'Failed to cancel batch' })
  }
}
