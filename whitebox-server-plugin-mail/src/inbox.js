import { z } from 'zod'
import multer from 'multer'
import { parsePhoneNumber } from 'libphonenumber-js'
import * as mailer from './mailer.js'
import * as attachments from './attachments.js'

const INBOX = 'whitebox_mail_inbox'

function normalizePhone(raw, defaultCountry) {
  try {
    const pn = parsePhoneNumber(String(raw).trim(), defaultCountry)
    // Use isPossible (correct length/format) rather than isValid (strict —
    // rejects 555-prefix US numbers and other "fictional" ranges that users
    // legitimately type into contact forms).
    return pn?.isPossible?.() ? pn.format('E.164') : null
  } catch { return null }
}

// Build identity claims from explicit form fields only.
//
// Body text is deliberately NOT parsed: reply bodies and signature lines
// routinely contain quoted threads, forwarded messages, our own outbound
// signature echoed back, and unrelated people's contact info. Extracting
// from there would attach the wrong identities to the wrong passports.
//
// Returns: [{ type, name, value }, ...]
export function extractIdentities({ from, phone, name, address, data, country }) {
  const out = []
  const seen = new Set()
  const push = (type, name_, value) => {
    if (!value) return
    const key = `${type}|${value}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ type, name: name_, value })
  }

  // Email (strong) — sender address, always lowercased
  if (from) push('email', 'address', String(from).toLowerCase())

  // Phone (strong) — top-level field or in data
  const phoneRaw = phone || data?.phone
  if (phoneRaw) {
    const e164 = normalizePhone(phoneRaw, country || data?.country || 'US')
    if (e164) push('phone', 'e164', e164)
  }

  // Name (weak) — top-level or data
  const fullName = (name || data?.name || '').trim()
  if (fullName) push('name', 'full', fullName)

  // Address (weak) — single-line postal blob
  const postalAddress = (address || data?.address || '').trim()
  if (postalAddress) push('address', 'postal', postalAddress)

  // URLs (weak) — explicit data fields only
  const urls = new Set()
  if (data?.url) urls.add(String(data.url))
  if (Array.isArray(data?.urls)) for (const u of data.urls) urls.add(String(u))
  for (const u of urls) {
    if (/^https?:\/\//i.test(u)) push('url', 'link', u)
  }

  return out
}

// Inbound webhooks may arrive as multipart/form-data (e.g. Mailgun, with
// attachments as files) or JSON (e.g. Postmark). multer parses the former and
// no-ops on the latter (the core JSON body parser handles it); the composed
// provider's parseInbound() reads whichever shape applies.
export const upload = multer({ storage: multer.memoryStorage() })

const UTM_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']

function extractUtms(query) {
  const utms = {}
  for (const field of UTM_FIELDS) {
    if (query[field]) utms[field] = query[field]
  }
  return utms
}

const inboxSchema = z.object({
  from: z.string().email(),
  to: z.string().email().optional(),
  subject: z.string().min(1),
  body: z.string().optional(),
  // Optional structured identity fields — linked to passport in addition to email
  phone: z.string().optional(),
  name: z.string().optional(),
  address: z.string().optional(),
  country: z.string().length(2).optional(),   // ISO-3166 alpha-2; used for phone parsing
  data: z.record(z.any()).optional().nullable(),
  passport_id: z.string().uuid().optional().nullable(),
})

// Dependencies captured once via init() — module-level singletons, no
// wrapping factory closure. Matches the core pattern.
let config
let db
let passports
let sessions
let awareness
let notify
let logger
let provider

// Module state set up in init()
let forwardQueue

export function init(deps) {
  ;({ config, db, passports, sessions, awareness, notify, logger, provider } = deps)
  const { q } = deps
  const mailConfig = config.mail

  forwardQueue = q.createQueue('mail:forward')

  q.createWorker('mail:forward', async job => {
    const { inboxId } = job.data
    const row = await db(INBOX).where({ id: inboxId }).first()
    if (!row) return

    const target = mailConfig.company
    if (!target) {
      logger.warn('mail.company not configured — skipping forward of form submission %d', inboxId)
      return
    }

    await mailer.send({
      to: target,
      subject: row.subject,
      text: row.body || '',
      html: row.body_html || undefined,
      replyTo: row.from,
      attachments: row.attachments || [],
    })
  })
}

function resolveRecipient(to) {
  // Keep an explicit `to` only when the provider recognizes it as one of our
  // own inbound addresses; otherwise route to the company catch-all.
  if (to && provider.ownsAddress?.(to)) return to
  return config.mail.company
}

export async function inboxMail(req, res) {
  const parsed = inboxSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() })
  }

  try {
    const {
      passport_id: passportId, from, to, subject, body,
      phone, name, address, country, data,
    } = parsed.data
    const utms = extractUtms(req.query)

    const session = await sessions.resolve(passportId || null, utms).catch(() => null)

    const linkedPassportId = passportId || session?.passport_id || null
    if (linkedPassportId) {
      const identities = extractIdentities({ from, phone, name, address, data, country })
      if (identities.length) {
        passports.link(linkedPassportId, identities).catch(err => {
          logger.warn({ err, count: identities.length }, 'Failed to link identities to passport: %s', linkedPassportId)
        })
      }
    }

    const savedAttachments = await Promise.all(
      (req.files || []).map(f => attachments.saveBuffer(f.buffer, f.originalname).catch(err => {
        logger.warn({ err }, 'Failed to save form attachment: %s', f.originalname)
        return null
      }))
    ).then(results => results.filter(Boolean))

    const recipient = resolveRecipient(to)

    const [row] = await db(INBOX).insert({
      passport_id: linkedPassportId,
      session_id: session?.id || null,
      source: 'form',
      from,
      to: recipient,
      subject,
      body,
      attachments: savedAttachments.length ? savedAttachments : null,
    }).returning('*')

    await forwardQueue.add('forward', { inboxId: row.id }).catch(err => {
      logger.error({ err }, 'Failed to enqueue form forward: %d', row.id)
    })

    await notify('mail.received', { type: 'mail.received', data: row })

    if (awareness && row.passport_id) {
      await awareness.record({
        passport_id: row.passport_id,
        session_id: row.session_id,
        ts: row.created_at || new Date(),
        channel: 'mail',
        direction: 'expression',
        source: 'email',
        content_id: `inbox:${row.id}`,
        text: `Subject: ${row.subject}\n\n${row.body || ''}`,
        meta: { from: row.from, to: row.to, source: row.source },
      }).catch(err => logger.warn({ err, inboxId: row.id }, 'awareness.record failed'))
    }

    res.json(row)
  } catch (err) {
    logger.error({ err }, 'Failed to handle inbox submission')
    res.status(500).json({ error: 'Failed to process message' })
  }
}

export async function handle(req, res) {
  // The provider owns webhook authenticity (Mailgun HMAC, Postmark basic-auth, …).
  if (!provider.verifySignature(req, 'inbound')) {
    return res.status(401).end()
  }

  // …and the provider-specific payload shape. It returns a normalized message
  // plus already-extracted attachment buffers (multipart files for Mailgun,
  // base64 parts for Postmark) so the storage path below stays uniform.
  const parsed = provider.parseInbound(req) || {}
  const from = parsed.from
  const to = parsed.to || config.mail.company
  const subject = parsed.subject
  const body = parsed.body || null
  const bodyHtml = parsed.bodyHtml || null

  // Save any attachments to disk with UUID names
  const savedAttachments = await Promise.all(
    (parsed.attachments || []).map(a => attachments.saveBuffer(a.content, a.filename).catch(err => {
      logger.warn({ err }, 'Failed to save inbound attachment: %s', a.filename)
      return null
    }))
  ).then(results => results.filter(Boolean))

  let passportId = null
  try {
    passportId = await passports.identify(null)
    // Inbound replies: only the sender email is trustworthy. Bodies are
    // full of quoted threads, forwarded contact info, and our own signature
    // echoed back — never extract identities from them.
    const identities = extractIdentities({ from })
    if (identities.length) {
      await passports.link(passportId, identities)
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to identify/link inbound sender: %s', from)
  }

  const session = passportId ? await sessions.resolve(passportId).catch(() => null) : null

  const [row] = await db(INBOX).insert({
    passport_id: passportId,
    session_id: session?.id || null,
    source: 'inbound',
    from,
    to,
    subject,
    body,
    body_html: bodyHtml,
    attachments: savedAttachments.length ? savedAttachments : null,
  }).returning('*')

  await notify('mail.received', { type: 'mail.received', data: row })

  if (awareness && row.passport_id) {
    const body = row.body || ''
    await awareness.record({
      passport_id: row.passport_id,
      session_id: row.session_id,
      ts: row.created_at || new Date(),
      channel: 'mail',
      direction: 'expression',
      source: 'email',
      content_id: `inbox:${row.id}`,
      text: `Subject: ${row.subject}\n\n${body}`,
      meta: { from: row.from, to: row.to, source: row.source },
    }).catch(err => logger.warn({ err, inboxId: row.id }, 'awareness.record failed'))
  }

  res.status(200).end()
}
