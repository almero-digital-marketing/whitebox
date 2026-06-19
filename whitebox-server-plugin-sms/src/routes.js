// HTTP routes for the SMS plugin. Pure wiring — modules are already constructed.
import express from 'express'
import * as outbox from './outbox.js'
import * as bulk from './bulk.js'
import * as inbox from './inbox.js'
import * as status from './status.js'
import * as suppressions from './suppressions.js'
import * as invalid from './invalid.js'

export function mountRoutes(app, { requireAuth }) {
  const router = express.Router()

  // Send (auth-gated)
  router.post('/outbox',               requireAuth, outbox.outboxSend)
  router.post('/bulk',                 requireAuth, bulk.create)
  router.get ('/bulk/:batchId',        requireAuth, bulk.show)
  router.post('/bulk/:batchId/cancel', requireAuth, bulk.cancel)

  // Provider webhooks (public; authenticity-verified inside via the provider).
  // The :provider segment selects which composed provider owns the callback.
  // Inbound replies are POST; delivery status is POST (Twilio) or GET (Mobica DLR).
  router.post('/webhooks/:provider/inbound', inbox.handle)
  router.post('/webhooks/:provider/status',  status.handle)
  router.get ('/webhooks/:provider/status',  status.handle)

  // Block lists (auth-gated)
  router.get   ('/suppressions',         requireAuth, suppressions.index)
  router.post  ('/suppressions',         requireAuth, suppressions.create)
  router.get   ('/suppressions/:phone',  requireAuth, suppressions.show)
  router.delete('/suppressions/:phone',  requireAuth, suppressions.destroy)

  router.get   ('/invalid',        requireAuth, invalid.index)
  router.post  ('/invalid',        requireAuth, invalid.create)
  router.get   ('/invalid/:phone', requireAuth, invalid.show)
  router.delete('/invalid/:phone', requireAuth, invalid.destroy)

  app.use('/sms', router)
}
