// HTTP routes for the mail plugin. Pure wiring: takes already-constructed
// modules and mounts them on the Express app. No dependency creation, no
// business logic, no awareness writes — those live elsewhere.

import express from 'express'
import * as suppressions from './suppressions.js'
import * as invalid from './invalid.js'
import * as inbox from './inbox.js'
import * as outbox from './outbox.js'
import * as tracking from './tracking.js'
import * as bulk from './bulk.js'

export function mountRoutes(app, { attachmentsFolder, requireAuth }) {
  const router = express.Router()

  // Public — contact form intake. The provider inbound/tracking webhooks are
  // also public but authenticity-verified inside their handlers via the provider.
  // Both webhook routes run multer so they accept multipart/form-data (e.g.
  // Mailgun) in addition to the globally-parsed JSON / urlencoded (e.g. Postmark);
  // multer no-ops on non-multipart bodies, leaving the core parsers' result intact.
  router.post('/inbox',             inbox.upload.array('files'), inbox.inboxMail)
  router.post('/webhooks/inbox',    inbox.upload.any(), inbox.handle)
  router.post('/webhooks/tracking', inbox.upload.any(), tracking.handle)

  // Auth-gated — send + admin
  router.post('/outbox', requireAuth, outbox.upload.array('files'), outbox.outboxMail)

  router.get   ('/suppressions',        requireAuth, suppressions.index)
  router.post  ('/suppressions',        requireAuth, suppressions.create)
  router.get   ('/suppressions/:email', requireAuth, suppressions.show)
  router.delete('/suppressions/:email', requireAuth, suppressions.destroy)

  router.get   ('/invalid',        requireAuth, invalid.index)
  router.post  ('/invalid',        requireAuth, invalid.create)
  router.get   ('/invalid/:email', requireAuth, invalid.show)
  router.delete('/invalid/:email', requireAuth, invalid.destroy)

  router.post('/bulk',                  requireAuth, bulk.create)
  router.get ('/bulk/:batchId',         requireAuth, bulk.show)
  router.post('/bulk/:batchId/cancel',  requireAuth, bulk.cancel)

  app.use('/mail/attachments', express.static(attachmentsFolder))
  app.use('/mail', router)
}
