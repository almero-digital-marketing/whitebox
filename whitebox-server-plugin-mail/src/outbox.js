import { z } from 'zod'
import multer from 'multer'
import * as suppressions from './suppressions.js'
import * as invalid from './invalid.js'
import * as mailer from './mailer.js'
import * as attachments from './attachments.js'

const TABLE = 'whitebox_mail_outbox'

const UTM_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']

function extractUtms(query) {
  const utms = {}
  for (const field of UTM_FIELDS) {
    if (query[field]) utms[field] = query[field]
  }
  return utms
}

export const upload = multer({ storage: multer.memoryStorage() })

const outboxSchema = z.object({
  to: z.string().email(),
  from: z.string().email().optional().nullable(),
  subject: z.string().min(1),
  html: z.string().optional(),
  text: z.string().optional(),
  template: z.string().optional().nullable(),
  attachment_urls: z.union([z.string().url(), z.array(z.string().url())]).optional(),
  passport_id: z.string().uuid().optional().nullable(),
  data: z.record(z.any()).optional().nullable(),
}).refine(d => d.html || d.text || d.template, {
  message: 'At least one of html, text, or template is required',
})

const STATUS_RANK = { queued: 0, sent: 1, delivered: 2, opened: 3, engaged: 4, bounced: 5, complained: 5, failed: 6, cancelled: 7 }

const ADVANCEABLE_FROM = Object.entries(STATUS_RANK)
  .filter(([, rank]) => rank < STATUS_RANK.complained)
  .map(([status]) => status)

function stripHtml(html) {
  if (!html) return ''
  return html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const DEFAULT_ATTEMPTS = 5
const DEFAULT_BACKOFF_MS = 5000

// Dependencies captured once via init() — module-level singletons, no
// wrapping factory closure. Matches the core pattern.
let db
let q
let templates
let passports
let sessions
let awareness
let notify
let config
let logger
let provider

// Module state set up in init()
let attempts
export let outboxQueue

export function init(deps) {
  ;({ db, q, templates, passports, sessions, awareness, notify, config, logger, provider } = deps)

  const mailConfig = config.mail
  attempts = mailConfig.outbox?.attempts ?? DEFAULT_ATTEMPTS

  outboxQueue = q.createQueue('mail:outbox')

  q.createWorker('mail:outbox', async job => {
    // Bulk batches arrive as { ids: [...] } (one provider call for the chunk);
    // single sends as { id }.
    if (Array.isArray(job.data.ids)) return processBatch(job.data.ids)
    return processSingle(job.data.id, job.attemptsMade + 1)
  }, {
    limiter: {
      max: mailConfig.outbox?.rate?.max ?? 10,
      duration: mailConfig.outbox?.rate?.duration ?? 60000,
    },
    defaultJobOptions: {
      attempts,
      backoff: { type: 'exponential', delay: mailConfig.outbox?.backoffMs ?? DEFAULT_BACKOFF_MS },
      removeOnComplete: true,
    },
  }).on('failed', async (job, err) => {
    if (!job?.data) return
    const attemptsMade = job.attemptsMade
    const terminal = attemptsMade >= (job.opts.attempts ?? attempts)
    try {
      if (Array.isArray(job.data.ids)) {
        // Whole-chunk failure (sendBatch threw). On the terminal attempt, fail
        // any rows still queued — none of them were sent.
        if (!terminal) return
        for (const id of job.data.ids) {
          const cur = await find(id)
          if (!cur || cur.status !== 'queued') continue
          const row = await failed(id, { reason: err.message, attempts: attemptsMade, terminal: true })
          if (row) await notify('mail.failed', { type: 'mail.failed', data: row }).catch(() => {})
        }
      } else if (job.data.id) {
        const row = await failed(job.data.id, { reason: err.message, attempts: attemptsMade, terminal })
        if (terminal && row) await notify('mail.failed', { type: 'mail.failed', data: row })
      }
    } catch (e) {
      logger.error({ err: e }, 'Failed to record outbox failure')
    }
  })
}

// Resolve a queued row's passport (mutates row.passport_id), then render it into
// a provider message. Note: outbound sets reply-to (not from) to the row's from,
// so the provider's default sender is used as From.
async function buildMessage(row) {
  const session = row.session_id && sessions?.findById
    ? await sessions.findById(row.session_id).catch(() => null)
    : null
  const html = row.html ?? (row.template && templates
    ? await templates.renderText({ layout: row.template, ...row, session, ...(row.data || {}) })
    : null)
  return {
    to: row.to,
    replyTo: row.from || null,
    subject: row.subject,
    html,
    text: row.text,
    attachments: row.attachments || [],
    track: true,
    data: row.data || {},
  }
}

// Record a send into the events bus + per-passport awareness.
async function recordSent(sentRow) {
  await notify('mail.sent', { type: 'mail.sent', data: sentRow })
  if (awareness && sentRow.passport_id) {
    const body = sentRow.text || stripHtml(sentRow.html) || ''
    await awareness.record({
      passport_id: sentRow.passport_id,
      session_id: sentRow.session_id,
      ts: sentRow.sent_at,
      channel: 'mail',
      direction: 'exposure',
      source: 'email',
      content_id: `outbox:${sentRow.id}`,
      text: `Subject: ${sentRow.subject}\n\n${body}`,
      meta: {
        to: sentRow.to,
        from: sentRow.from,
        template: sentRow.template,
        provider_message_id: sentRow.provider_message_id,
      },
    }).catch(err => logger.warn({ err, outboxId: sentRow.id }, 'awareness.record failed'))
  }
}

// Blocklist the address if the provider classifies the send error as permanent.
async function markInvalidIfPermanent(row, errLike) {
  const c = provider.classifyError?.(errLike) ?? invalid.classifyMailerError(errLike)
  if (c.permanent) {
    await invalid.add({
      email: row.to,
      reason: 'rejected',
      source: provider.name,
      errorMessage: `${c.statusCode ? `[${c.statusCode}] ` : ''}${c.message}`.slice(0, 512),
    }).catch(e => logger.error({ err: e }, 'Failed to record invalid recipient: %s', row.to))
  }
  return c
}

async function processSingle(id, attemptsMade) {
  const row = await find(id)
  if (!row || row.status !== 'queued') return

  const blockReason = await preflightBlock(row.to)
  if (blockReason) {
    const failedRow = await failed(id, { reason: blockReason, attempts: attemptsMade, terminal: true })
    if (failedRow) await notify('mail.failed', { type: 'mail.failed', data: failedRow })
    return
  }

  try {
    await resolveRecipient(row)
  } catch (err) {
    logger.warn({ err }, 'Failed to identify/link outbox recipient: %s', row.to)
  }

  let info
  try {
    info = await mailer.send(await buildMessage(row))
  } catch (err) {
    const c = await markInvalidIfPermanent(row, err)
    if (c.permanent) {
      const failedRow = await failed(id, { reason: `rejected:${c.message}`, attempts: attemptsMade, terminal: true })
      if (failedRow) await notify('mail.failed', { type: 'mail.failed', data: failedRow })
      return   // swallow — no BullMQ retry
    }
    throw err   // transient — let BullMQ retry
  }

  const messageId = info?.messageId || null
  if (!messageId) logger.error({ outboxId: id }, 'Provider returned no messageId — tracking webhooks will not match')
  const sentRow = await sent(id, messageId)
  await recordSent(sentRow)
}

// One provider batch call for a chunk of queued rows from a bulk send. Rows that
// preflight-block or error in the result are failed individually; a thrown
// sendBatch (transient) propagates so BullMQ retries the whole chunk.
async function processBatch(ids) {
  const rows = []
  for (const id of ids) {
    const row = await find(id)
    if (row && row.status === 'queued') rows.push(row)
  }
  if (!rows.length) return

  const messages = []
  const sendable = []
  for (const row of rows) {
    const blockReason = await preflightBlock(row.to)
    if (blockReason) {
      const failedRow = await failed(row.id, { reason: blockReason, attempts: 1, terminal: true })
      if (failedRow) await notify('mail.failed', { type: 'mail.failed', data: failedRow })
      continue
    }
    try {
      await resolveRecipient(row)
    } catch (err) {
      logger.warn({ err }, 'Failed to identify/link outbox recipient: %s', row.to)
    }
    messages.push(await buildMessage(row))
    sendable.push(row)
  }
  if (!sendable.length) return

  const results = await mailer.sendBatch(messages)

  for (let i = 0; i < sendable.length; i++) {
    const row = sendable[i]
    const r = results[i] || {}
    if (r.error) {
      const c = await markInvalidIfPermanent(row, { message: r.error })
      const failedRow = await failed(row.id, {
        reason: `${c.permanent ? 'rejected:' : ''}${r.error}`.slice(0, 512),
        attempts: 1,
        terminal: true,
      })
      if (failedRow) await notify('mail.failed', { type: 'mail.failed', data: failedRow })
      continue
    }
    const sentRow = await sent(row.id, r.messageId || null)
    await recordSent(sentRow)
  }
}

async function preflightBlock(email) {
  const inv = await invalid.check(email).catch(() => null)
  if (inv) return `invalid:${inv.reason}`
  const sup = await suppressions.check(email).catch(() => null)
  if (sup) return `suppressed:${sup.reason}`
  return null
}

export async function create({ passportId, sessionId, from, to, subject, html, text, template, idempotencyKey, attachments, batchId, data }) {
  if (idempotencyKey) {
    const existing = await db(TABLE).where({ idempotency_key: idempotencyKey }).first()
    if (existing) return existing
  }

  try {
    const [row] = await db(TABLE).insert({
      passport_id: passportId || null,
      session_id: sessionId || null,
      from: from || null,
      to,
      subject,
      html: html || null,
      text: text || null,
      template: template || null,
      idempotency_key: idempotencyKey || null,
      attachments: attachments?.length ? attachments : null,
      batch_id: batchId || null,
      data: data || null,
    }).returning('*')
    return row
  } catch (err) {
    if (idempotencyKey && /unique|duplicate/i.test(err.message)) {
      const existing = await db(TABLE).where({ idempotency_key: idempotencyKey }).first()
      if (existing) return existing
    }
    throw err
  }
}

export async function createMany(items) {
  if (!items.length) return []
  const rows = await db(TABLE).insert(items.map(item => ({
    passport_id: item.passportId || null,
    session_id: item.sessionId || null,
    from: item.from || null,
    to: item.to,
    subject: item.subject,
    html: item.html || null,
    text: item.text || null,
    template: item.template || null,
    attachments: item.attachments?.length ? item.attachments : null,
    batch_id: item.batchId || null,
    data: item.data || null,
  }))).returning('*')
  return rows
}

export async function markStuck(thresholdMs = 10 * 60 * 1000) {
  const cutoff = new Date(Date.now() - thresholdMs)
  const stuck = await db(TABLE)
    .where('status', 'queued')
    .where('created_at', '<', cutoff)
    .update({
      status: 'failed',
      failed_at: new Date(),
      failure_reason: 'stuck',
    })
    .returning('*')

  if (stuck.length) {
    logger.warn({ count: stuck.length }, 'Marked %d stuck outbox row(s) as failed', stuck.length)
    for (const row of stuck) {
      await notify('mail.failed', { type: 'mail.failed', data: row }).catch(() => {})
    }
  }

  return stuck.length
}

export async function cancelBatch(batchId) {
  // Only cancel rows still waiting to be sent. Already-sent rows stay as-is.
  const cancelled = await db(TABLE)
    .where({ batch_id: batchId, status: 'queued' })
    .update({
      status: 'cancelled',
      cancelled_at: new Date(),
      failure_reason: 'cancelled',
    })
    .returning('*')

  // Best-effort: remove pending BullMQ jobs so workers don't even pick them up.
  // (Workers also short-circuit on status !== 'queued', so DB state is the source of truth.)
  if (cancelled.length && typeof outboxQueue.remove === 'function') {
    await Promise.all(cancelled.map(row =>
      outboxQueue.remove(String(row.id)).catch(() => {})
    ))
  }

  return { batch_id: batchId, cancelled: cancelled.length }
}

export async function batchStats(batchId) {
  const rows = await db(TABLE).where({ batch_id: batchId }).select('status').count('* as count').groupBy('status')
  const totals = {}
  for (const r of rows) totals[r.status] = parseInt(r.count, 10)
  return { batch_id: batchId, totals }
}

export async function sent(id, providerMessageId) {
  const [row] = await db(TABLE).where({ id }).update({
    provider_message_id: providerMessageId,
    status: 'sent',
    sent_at: new Date(),
  }).returning('*')
  return row
}

// Resolve an outbox recipient to a passport and link the email to it. Order:
// an explicit passport_id, else the existing passport that already owns this
// email (so we DON'T mint a duplicate per send), else a fresh visitor. The
// resolved id is persisted onto the row (and mutated in place) so the awareness
// record on send and open/click tracking — both keyed off row.passport_id —
// attribute to the right passport. Returns the passport id (or null).
export async function resolveRecipient(row) {
  const passportId = row.passport_id
    ?? (await passports.findByIdentity('email', row.to))?.id
    ?? await passports.identify(null)
  if (!passportId || !row.to) return passportId

  await passports.link(passportId, [{ type: 'email', name: 'address', value: row.to }]).catch(err => {
    logger.warn({ err }, 'Failed to link outbox recipient to passport: %s', row.to)
  })
  if (passportId !== row.passport_id) {
    await db(TABLE).where({ id: row.id }).update({ passport_id: passportId })
    row.passport_id = passportId
  }
  return passportId
}

export async function failed(id, { reason, attempts, terminal }) {
  const trimmed = String(reason).slice(0, 512)
  const stamp = new Date().toISOString()
  const entry = `[${stamp}] attempt ${attempts}: ${trimmed}`

  const row = await db(TABLE).where({ id }).first()
  if (!row) return null

  const log = row.failure_log ? `${row.failure_log}\n${entry}` : entry

  const update = { attempts, failure_reason: trimmed, failure_log: log }
  if (terminal) {
    update.status = 'failed'
    update.failed_at = new Date()
  }

  const [updated] = await db(TABLE).where({ id }).update(update).returning('*')
  return updated
}

// Advance an outbox row's status from a tracking webhook. Normally matched by
// provider_message_id. For batched sends where the provider returns no
// per-recipient id (e.g. Mailgun's recipient-variables batch), the row's
// provider_message_id is null — so on the first event for that recipient we
// match by email (scoped to batched, still-unidentified rows) and backfill the
// id the webhook carries, so subsequent events match directly.
export async function track(providerMessageId, status, { recipient } = {}) {
  const targetRank = STATUS_RANK[status]
  if (targetRank == null) return null

  const advanceableFrom = ADVANCEABLE_FROM.filter(s => STATUS_RANK[s] < targetRank)
  if (!advanceableFrom.length) return null

  const field = `${status}_at`

  if (providerMessageId) {
    const [updated] = await db(TABLE)
      .where({ provider_message_id: providerMessageId })
      .whereIn('status', advanceableFrom)
      .update({ status, [field]: new Date() })
      .returning('*')
    if (updated) return updated
  }

  // Backfill path: a batched row that hasn't been bound to an id yet.
  if (providerMessageId && recipient) {
    const candidate = await db(TABLE)
      .whereRaw('lower("to") = ?', [String(recipient).toLowerCase()])
      .whereNull('provider_message_id')
      .whereNotNull('batch_id')
      .whereIn('status', advanceableFrom)
      .orderBy('sent_at', 'desc')
      .first()
    if (candidate) {
      const [updated] = await db(TABLE)
        .where({ id: candidate.id })
        .update({ provider_message_id: providerMessageId, status, [field]: new Date() })
        .returning('*')
      return updated || null
    }
  }

  return null
}

export async function find(id) {
  const row = await db(TABLE).where({ id }).first()
  return row
}

export async function outboxMail(req, res) {
  const parsed = outboxSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() })
  }

  try {
    const body = parsed.data
    const { passport_id: passportId, from, to, subject, html, text, template, attachment_urls: attachmentUrls, data } = body
    const utms = extractUtms(req.query)
    const idempotencyKey = req.get('idempotency-key') || null

    const session = await sessions.resolve(passportId || null, utms).catch(() => null)

    const fileAttachments = await Promise.all(
      (req.files || []).map(f => attachments.saveBuffer(f.buffer, f.originalname))
    )
    const urls = Array.isArray(attachmentUrls) ? attachmentUrls : attachmentUrls ? [attachmentUrls] : []
    const urlAttachments = await Promise.all(
      urls.map(url => attachments.saveUrl(url).catch(err => {
        logger.warn({ err }, 'Failed to fetch attachment URL: %s', url)
        return null
      }))
    )
    const resolvedAttachments = [...fileAttachments, ...urlAttachments].filter(Boolean)

    const row = await create({
      passportId: passportId || session?.passport_id || null,
      sessionId: session?.id || null,
      from: from || null,
      to,
      subject,
      html,
      text,
      template: template || null,
      idempotencyKey,
      attachments: resolvedAttachments.length ? resolvedAttachments : null,
      data: data || null,
    })

    if (row.status === 'queued' && !row.sent_at) {
      await outboxQueue.add('send', { id: row.id }, { jobId: idempotencyKey || undefined })
      await notify('mail.queued', { type: 'mail.queued', data: row })
    }

    res.json(row)
  } catch (err) {
    logger.error({ err }, 'Failed to queue outbox email')
    res.status(500).json({ error: 'Failed to queue email' })
  }
}
