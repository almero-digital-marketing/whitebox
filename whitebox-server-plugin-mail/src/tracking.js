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
let provider

export function init(deps) {
  ;({ notify, awareness, logger, provider } = deps)
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
    const row = await outbox.track(messageId, status).catch(err => {
      logger.error({ err }, 'Failed to track outbox status: %s %s', messageId, status)
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
