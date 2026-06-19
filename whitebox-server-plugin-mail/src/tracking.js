import * as suppressions from './suppressions.js'
import * as invalid from './invalid.js'
import * as outbox from './outbox.js'

// The provider normalizes its own event names into this canonical vocabulary
// (delivered | opened | clicked | bounced | complained | unsubscribed); here we
// map the deliverability subset onto internal outbox statuses.
const statusMap = {
  delivered: 'delivered',
  opened: 'opened',
  clicked: 'engaged',
  bounced: 'bounced',
  complained: 'complained',
}

// Tracked transitions we mirror into awareness (not plain delivery / failure).
// An *open* means the recipient was actually exposed to the full message, so
// it's recorded as `exposure` carrying subject + body — the send only exposed
// them to the subject (the inbox preview). A *click* ('engaged') is an active
// signal, recorded as `expression`. They show up in /analytics/timeline +
// /analytics/ask alongside the send, interleaving "we sent X" with "they read X".
const RECORDED_STATUSES = new Set(['opened', 'engaged'])

// Dependencies captured once via init() — module-level singletons, no
// wrapping factory closure. Matches the core pattern.
let notify
let awareness
let logger
let provider

export function init(deps) {
  ;({ notify, awareness, logger, provider } = deps)
}

async function recordTrackedEvent(row, status) {
  if (!awareness?.record) return
  if (!row?.passport_id) return                     // nothing to attach to
  const opened  = status === 'opened'
  const subject = row.subject || '(no subject)'
  const body    = row.text || outbox.stripHtml(row.html) || ''
  try {
    await awareness.record({
      passport_id: row.passport_id,
      session_id:  row.session_id || null,
      ts:          new Date(),
      channel:     'mail',
      // An open is exposure to the full content (subject + body); a click is an
      // active expression — its body already entered awareness at the open.
      direction:   opened ? 'exposure' : 'expression',
      source:      status,                          // 'opened' | 'engaged'
      // Stable id keyed to the outbox row + status, so a re-delivered webhook
      // for the same event hashes to the same content and dedupes naturally.
      content_id:  `mail:${row.id}:${status}`,
      text:        opened ? `Subject: ${subject}\n\n${body}` : `Clicked in: ${subject}`,
      meta: {
        outbox_id:           row.id,
        provider_message_id: row.provider_message_id,
        to:                  row.to,
        status,
      },
    })
  } catch (err) {
    logger.warn({ err, outbox_id: row.id, status }, 'Failed to record mail engagement in awareness')
  }
}

export async function handle(req, res) {
  // The provider owns webhook authenticity and its own event payload shape,
  // normalizing it into { messageId, event, recipient, severity, errorMessage }.
  if (!provider.verifySignature(req, 'tracking')) {
    return res.status(401).end()
  }

  const ev = provider.parseTracking(req) || {}
  const { messageId, event, recipient, severity } = ev
  const errorMessage = ev.errorMessage || null

  // --- Outbox status tracking ---
  const status = statusMap[event]
  if (status && messageId) {
    // recipient lets track() match + backfill batched rows that have no
    // per-recipient provider id yet (e.g. Mailgun recipient-variables batches).
    const row = await outbox.track(messageId, status, { recipient }).catch(err => {
      logger.error({ err }, 'Failed to track outbox status: %s %s', messageId, status)
      return null
    })
    if (row) {
      await notify(`mail.${status}`, { type: `mail.${status}`, data: row })
      if (RECORDED_STATUSES.has(status)) await recordTrackedEvent(row, status)
    }
  }

  // --- Suppression list (user intent) ---
  if (recipient) {
    let reason = null
    if (event === 'unsubscribed') reason = 'unsubscribed'
    else if (event === 'complained') reason = 'complained'

    if (reason) {
      await suppressions.add({ email: recipient, reason, source: provider.name }).catch(err => {
        logger.error({ err }, 'Failed to add suppression: %s', recipient)
      })
    }
  }

  // --- Invalid list (technical undeliverability) ---
  // Hard bounces only — soft bounces should be retried, not blocklisted
  if (recipient && event === 'bounced' && severity === 'permanent') {
    await invalid.add({
      email: recipient,
      reason: 'bounced',
      source: provider.name,
      errorMessage,
    }).catch(err => {
      logger.error({ err }, 'Failed to add invalid recipient: %s', recipient)
    })
  }

  res.status(200).end()
}
