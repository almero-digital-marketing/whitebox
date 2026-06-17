// HTTP routes for the analytics plugin. All auth-gated, read-mostly.
// Six endpoints: recall, population, timeline, context (debug), forget, ask.

import express from 'express'
import { z } from 'zod'
import { createAskHandler } from './ask.js'

const recallSchema = z.object({
  passport_id: z.string().uuid(),
  query:       z.string().min(1),
  limit:       z.number().int().positive().max(100).optional(),
})

const populationSchema = z.object({
  query:      z.string().min(1),
  similarity: z.number().min(0).max(1).optional(),
  limit:      z.number().int().positive().max(10000).optional(),
})

export function mountRoutes(app, { requireAuth, awareness, ai, context, logger }) {
  const router = express.Router()

  router.post('/recall', requireAuth, async (req, res) => {
    const parsed = recallSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
    try {
      const hits = await awareness.recall(parsed.data)
      res.json({ hits })
    } catch (err) {
      logger.error({ err }, 'recall failed')
      res.status(500).json({ error: 'recall failed' })
    }
  })

  router.post('/population', requireAuth, async (req, res) => {
    const parsed = populationSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
    try {
      res.json(await awareness.population(parsed.data))
    } catch (err) {
      logger.error({ err }, 'population failed')
      res.status(500).json({ error: 'population failed' })
    }
  })

  router.get('/timeline/:passport_id', requireAuth, async (req, res) => {
    try {
      const rows = await awareness.timeline({
        passport_id: req.params.passport_id,
        from:        req.query.from ? new Date(req.query.from) : null,
        to:          req.query.to   ? new Date(req.query.to)   : null,
        channels:    req.query.channels   ? String(req.query.channels).split(',')   : null,
        directions:  req.query.directions ? String(req.query.directions).split(',') : null,
      })
      res.json(rows)
    } catch (err) {
      logger.error({ err }, 'timeline failed')
      res.status(500).json({ error: 'timeline failed' })
    }
  })

  // Debug surface: shows exactly what each context provider returns for a
  // passport. Same call /ask makes internally, minus the LLM step. Useful
  // for verifying that a newly registered plugin is feeding the right
  // shape into the prompt.
  // Query params:
  //   provider=crm,billing   — comma-separated allowlist (default: all)
  //   page=1                 — 1-based page (default 1)
  //   page_size=20           — items per provider (default 20, max 200)
  router.get('/context/:passport_id', requireAuth, async (req, res) => {
    try {
      const allProviders = context?.names?.() ?? []
      const requested = req.query.provider
        ? String(req.query.provider).split(',').map(s => s.trim()).filter(Boolean)
        : null

      const unknown = requested ? requested.filter(n => !allProviders.includes(n)) : []
      if (unknown.length) {
        return res.status(400).json({ error: 'unknown providers', unknown, available: allProviders })
      }

      const page     = Math.max(1, Number(req.query.page) || 1)
      const pageSize = Math.min(200, Math.max(1, Number(req.query.page_size) || 20))
      const offset   = (page - 1) * pageSize

      if (!context?.collect) {
        return res.json({ providers: [], page, page_size: pageSize, context: {} })
      }

      const collected = await context.collect(req.params.passport_id, {
        providers: requested ?? undefined,
        limit:     pageSize,
        offset,
      })

      // has_more is a best-effort hint per array provider: if the slice came
      // back full it's likely there's another page. Object providers omit it.
      const has_more = {}
      for (const [name, value] of Object.entries(collected)) {
        if (Array.isArray(value)) has_more[name] = value.length === pageSize
      }

      res.json({
        providers: requested ?? allProviders,
        page, page_size: pageSize, has_more,
        context: collected,
      })
    } catch (err) {
      logger.error({ err }, 'context inspect failed')
      res.status(500).json({ error: 'context inspect failed' })
    }
  })

  router.delete('/passport/:passport_id', requireAuth, async (req, res) => {
    try {
      const deleted = await awareness.forget({ passport_id: req.params.passport_id })
      res.json({ deleted })
    } catch (err) {
      logger.error({ err }, 'forget failed')
      res.status(500).json({ error: 'forget failed' })
    }
  })

  // /ask lives in ask.js because the system prompt + formatting helpers are
  // a substantial concern on their own.
  router.post('/ask', requireAuth, createAskHandler({ awareness, ai, context, logger }))

  app.use('/analytics', router)
}
