// HTTP routes.
//   POST /conversions/events   PUBLIC browser ingress — the client SDK posts
//                              standard/custom conversion events here. No Bearer:
//                              the passport id it carries IS the identifier
//                              (same trust model as /sessions/resolve).
//   GET  /conversions/events   PRIVILEGED — inspect the audit log (Bearer auth).

import express from 'express'
import { z } from 'zod'
import { parsePage, page } from 'whitebox-server/pagination'

import * as ingest from './ingest.js'
import * as store from './store.js'

const ingestSchema = z.object({
  passport_id: z.string().min(1).optional(),
  events:      z.array(z.record(z.string(), z.unknown())).min(1).max(50),
  signals:     z.record(z.string(), z.unknown()).optional(),
})

export function mountRoutes(app, { requireAuth, logger }) {
  const router = express.Router()

  // ── public ingress ───────────────────────────────────────────────────────
  router.post('/events', async (req, res) => {
    const parsed = ingestSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

    const { passport_id: passportId, events, signals } = parsed.data
    // No passport ⇒ nothing to attribute. Accept-but-ignore (202) so a beacon
    // fired before /sessions/resolve completes doesn't surface as an error.
    if (!passportId) return res.status(202).json({ reason: 'no_passport' })

    try {
      const results = await ingest.ingestBatch(passportId, events, {
        signals: signals || {},
        ip: req.ip,
        user_agent: req.get('user-agent') || null,
      })
      res.json({ results })
    } catch (err) {
      logger?.error?.({ err }, 'conversions ingest failed')
      res.status(500).json({ error: 'conversions ingest failed' })
    }
  })

  // ── privileged audit-log read ────────────────────────────────────────────
  router.get('/events', requireAuth, async (req, res) => {
    try {
      const { limit, offset } = parsePage(req.query, { defaultLimit: 50, maxLimit: 200 })
      const passportId = req.query.passport_id
      const rows = passportId
        ? await store.listForPassport(passportId, { limit: limit + 1, offset })
        : await store.list({ limit: limit + 1, offset })
      res.json(page(rows, { limit, offset }))
    } catch (err) {
      logger?.error?.({ err }, 'conversions list failed')
      res.status(500).json({ error: 'conversions list failed' })
    }
  })

  app.use('/conversions', router)
}
