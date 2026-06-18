// HTTP routes for the engagement plugin.
//
// One public endpoint for the browser's sendBeacon fallback on unload, plus
// auth-gated admin endpoints for inspecting / invalidating the content cache.

import express from 'express'
import { parsePage, page } from 'whitebox-server/pagination'
import { batchSchema } from './events.js'

export function mountRoutes(app, { db, content, dispatchBatchEvent, requireAuth }) {
  const router = express.Router()

  // Public — browser fallback. The WebSocket path is preferred; this
  // catches events queued at pagehide when WS frames may not flush.
  router.post('/events', async (req, res) => {
    const parsed = batchSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })

    const sessionId  = req.query.session_id  || req.get('x-whitebox-session')  || null
    const passportId = req.query.passport_id || req.get('x-whitebox-passport') || null
    if (!passportId) return res.status(400).json({ error: 'passport_id required' })

    const visitor = { passportId, sessionId: sessionId ? parseInt(sessionId, 10) : null }
    for (const e of parsed.data.events) await dispatchBatchEvent(visitor, e)
    res.status(202).end()
  })

  // Admin — content cache inspection + invalidation.
  router.get('/content', requireAuth, async (req, res) => {
    const { limit, offset } = parsePage(req.query, { defaultLimit: 100, maxLimit: 500 })
    const rows = await db('whitebox_engagement_content')
      .orderBy('generated_at', 'desc')
      .offset(offset)
      .limit(limit + 1)   // one extra → has_more
    res.json(page(rows, { limit, offset }))
  })

  router.get('/content/:url(*)', requireAuth, async (req, res) => {
    const row = await db('whitebox_engagement_content').where({ url: req.params.url }).first()
    if (!row) return res.status(404).end()
    res.json(row)
  })

  router.delete('/content/:url(*)', requireAuth, async (req, res) => {
    const deleted = await content.invalidate(req.params.url)
    res.json({ deleted })
  })

  app.use('/engagement', router)
}
