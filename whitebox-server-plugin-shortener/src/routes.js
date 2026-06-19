// HTTP routes.
//   GET  /:code               PUBLIC, short host only — resolve → 302 (+token).
//   POST /shortener/links     Bearer — create a link.
//   POST /shortener/claim     PUBLIC — redeem a claim token → { passport_id, data }.
//   GET  /shortener/links/:code  Bearer — inspect + click stats.
//   GET  /shortener/links     Bearer — list (paginated).

import express from 'express'
import { parsePage, page } from 'whitebox-server/pagination'

import * as service from './service.js'

// Single-segment paths on the short host that are NOT short codes.
const RESERVED = new Set(['', 'health', 'healthz', 'favicon.ico', 'robots.txt', 'mcp', 'shortener', 'sessions', 'output'])

export function mountRoutes(app, { requireAuth, host, logger }) {
  const router = express.Router()

  router.post('/links', requireAuth, async (req, res) => {
    try {
      res.status(201).json(await service.createLink(req.body || {}))
    } catch (err) {
      if (err.status === 400) return res.status(400).json({ error: err.message })
      logger?.error?.({ err }, 'shortener create failed')
      res.status(500).json({ error: 'create failed' })
    }
  })

  // Public — the token IS the credential. Soft on bad/used/expired tokens
  // (returns { bound:false }) so the destination page never errors.
  router.post('/claim', async (req, res) => {
    try {
      const { token, passport_id } = req.body || {}
      res.json(await service.claim(token, passport_id))
    } catch (err) {
      logger?.error?.({ err }, 'shortener claim failed')
      res.status(500).json({ error: 'claim failed' })
    }
  })

  router.get('/links/:code', requireAuth, async (req, res) => {
    const stats = await service.linkStats(req.params.code)
    if (!stats) return res.status(404).json({ error: 'not found' })
    res.json(stats)
  })

  router.get('/links', requireAuth, async (req, res) => {
    const { limit, offset } = parsePage(req.query, { defaultLimit: 50, maxLimit: 200 })
    const rows = await service.listLinks({ limit: limit + 1, offset })
    res.json(page(rows, { limit, offset }))
  })

  app.use('/shortener', router)

  // The public redirect — ONLY on the short host. On any other host (or if no
  // baseUrl was configured) it falls through, so it can't shadow the API routes.
  app.get('/:code', async (req, res, next) => {
    if (!host || req.hostname !== host) return next()
    if (RESERVED.has(req.params.code)) return next()
    try {
      const result = await service.resolveRedirect(req.params.code, {
        ip: req.ip, user_agent: req.get('user-agent') || null,
      })
      if (!result) return res.status(404).type('text/plain').send('Not found')
      res.redirect(302, result.location)
    } catch (err) {
      logger?.error?.({ err }, 'shortener redirect failed')
      res.status(500).type('text/plain').send('error')
    }
  })
}
