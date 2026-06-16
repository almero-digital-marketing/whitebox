import * as suppressions from './suppressions.js'
import * as invalid from './invalid.js'
import * as signature from './signature.js'
import * as outbox from './outbox.js'

const statusMap = {
  delivered: 'delivered',
  opened: 'opened',
  clicked: 'engaged',
  failed: 'bounced',
  complained: 'complained',
}

// Status transitions that represent a user *expressing* engagement with the
// email (not just delivery / failure). These get recorded into awareness so
// they show up in /analytics/timeline + /analytics/ask alongside the original
// send exposure. The user story interleaves "we sent X" with "they opened X".
const ENGAGEMENT_STATUSES = new Set(['opened', 'engaged'])

// Dependencies captured once via init() — module-level singletons, no
// wrapping factory closure. Matches the core pattern.
let notify
let awareness
let logger

export function init(deps) {
  ;({ notify, awareness, logger } = deps)
}

async function recordEngagement(row, status) {
  if (!awareness?.record) return
  if (!row?.passport_id) return                     // nothing to attach to
  try {
    await awareness.record({
      passport_id: row.passport_id,
      session_id:  row.session_id || null,
      ts:          new Date(),
      channel:     'mail',
      direction:   'expression',                    // they engaged — not just received
      source:      status,                          // 'opened' | 'engaged'
      // Stable id keyed to the outbox row + status, so a re-delivered webhook
      // for the same event hashes to the same content and dedupes naturally.
      content_id:  `mail:${row.id}:${status}`,
      text:        `${status === 'engaged' ? 'Clicked in' : 'Opened'}: ${row.subject || '(no subject)'}`,
      meta: {
        outbox_id:  row.id,
        mailgun_id: row.mailgun_id,
        to:         row.to,
        status,
      },
    })
  } catch (err) {
    logger.warn({ err, outbox_id: row.id, status }, 'Failed to record mail engagement in awareness')
  }
}

export async function handle(req, res) {
  if (!signature.verify(req.body?.signature, 'Tracking')) {
    return res.status(401).end()
  }

  const eventData = req.body?.['event-data']
  const event = eventData?.event
  const mailgunId = eventData?.message?.headers?.['message-id']
  const recipient = eventData?.recipient
  const severity = eventData?.severity
  const errorMessage = eventData?.['delivery-status']?.message || eventData?.reason || null

  // --- Outbox status tracking ---
  const status = statusMap[event]
  if (status && mailgunId) {
    const row = await outbox.track(mailgunId, status).catch(err => {
      logger.error({ err }, 'Failed to track outbox status: %s %s', mailgunId, status)
      return null
    })
    if (row) {
      await notify(`mail.${status}`, { type: `mail.${status}`, data: row })
      if (ENGAGEMENT_STATUSES.has(status)) await recordEngagement(row, status)
    }
  }

  // --- Suppression list (user intent) ---
  if (recipient) {
    let reason = null
    if (event === 'unsubscribed') reason = 'unsubscribed'
    else if (event === 'complained') reason = 'complained'

    if (reason) {
      await suppressions.add({ email: recipient, reason, source: 'mailgun' }).catch(err => {
        logger.error({ err }, 'Failed to add suppression: %s', recipient)
      })
    }
  }

  // --- Invalid list (technical undeliverability) ---
  // Hard bounces only — soft bounces should be retried, not blocklisted
  if (recipient && event === 'failed' && severity === 'permanent') {
    await invalid.add({
      email: recipient,
      reason: 'bounced',
      source: 'mailgun',
      errorMessage,
    }).catch(err => {
      logger.error({ err }, 'Failed to add invalid recipient: %s', recipient)
    })
  }

  res.status(200).end()
}
