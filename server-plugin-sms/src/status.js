import * as outbox from './outbox.js'
import * as invalid from './invalid.js'

// Delivery status callbacks (Twilio status callback / Mobica DLR). The provider
// in the path authenticates + normalizes the payload into
// { messageId, status (canonical), recipient, errorMessage, blacklisted }.
// Mobica DLRs arrive as GET, Twilio as POST — the route registers both.
let awareness, notify, logger, router

export function init(deps) {
  ;({ awareness, notify, logger, router } = deps)
}

export async function handle(req, res) {
  const provider = router.byName(req.params.provider)
  if (!provider) return res.status(404).end()
  if (!provider.verifySignature?.(req, 'status')) return res.status(401).end()
  if (typeof provider.parseStatus !== 'function') return res.status(501).end()

  const ev = provider.parseStatus(req) || {}
  const { messageId, status, recipient, blacklisted } = ev
  const errorMessage = ev.errorMessage || null

  // Advance the outbox status. track() matches on the (globally unique) message
  // id and returns the row only when it advanced one of OUR sends. So in a
  // fan-out DLR topology — one provider callback URL (e.g. Mobica's single panel
  // URL) broadcast to many WhiteBox instances, each receiving every report — an
  // id this instance never minted simply no-ops here, with no side effects.
  if (status && messageId) {
    const row = await outbox.track(messageId, status).catch(err => {
      logger.error({ err }, 'Failed to track sms status: %s %s', messageId, status)
      return null
    })
    if (row) {
      await notify(`sms.${status}`, { type: `sms.${status}`, data: row })

      // A hard non-delivery / blacklist means don't retry — but blocklist only
      // when the report matched one of our rows. Acting on a fanned-out id that
      // belongs to another instance would suppress that instance's recipient.
      if (blacklisted || status === 'undelivered' || status === 'failed') {
        const phone = row.to || recipient
        if (phone) await invalid.add({
          phone,
          reason: blacklisted ? 'rejected' : 'undeliverable',
          source: provider.name,
          errorMessage,
        }).catch(err => logger.error({ err }, 'Failed to add invalid number: %s', phone))
      }
    }
  }

  res.status(200).send('OK')
}
