// HTTP routes for the analytics plugin. All auth-gated, read-mostly.
// Seven endpoints: recall, population, timeline, context (debug), forget, ask,
// ask-population.

import express from 'express'
import { z } from 'zod'
import { parsePage, page, pageSlice } from 'whitebox-server/pagination'
import { createAskHandler, createAskPopulationHandler } from './ask.js'

// limit/offset are parsed by the shared pagination helper; the schemas just bound
// them so a bad value 400s rather than silently clamping.
const recallSchema = z.object({
  passport_id:    z.string().uuid(),
  query:          z.string().min(1),
  limit:          z.number().int().positive().max(100).optional(),
  offset:         z.number().int().nonnegative().optional(),
  min_similarity: z.number().min(0).max(1).optional(),   // relevance floor (0 = off)
})

const populationSchema = z.object({
  query:          z.string().min(1),
  similarity:     z.number().min(0).max(1).optional(),
  min_engagement: z.number().min(0).max(1).optional(),
  limit:          z.number().int().positive().max(200).optional(),
  offset:         z.number().int().nonnegative().optional(),
})

export function mountRoutes(app, { requireAuth, awareness, context, logger }) {
  const router = express.Router()

  router.post('/recall', requireAuth, async (req, res) => {
    const parsed = recallSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
    try {
      const { limit, offset } = parsePage(parsed.data, { defaultLimit: 10, maxLimit: 100 })
      // fetch one extra so the envelope knows there's a next page (no COUNT query)
      const hits = await awareness.recall({
        passport_id: parsed.data.passport_id, query: parsed.data.query,
        limit: limit + 1, offset, min_similarity: parsed.data.min_similarity ?? 0,
      })
      res.json(page(hits, { limit, offset }))
    } catch (err) {
      logger.error({ err }, 'recall failed')
      res.status(500).json({ error: 'recall failed' })
    }
  })

  router.post('/population', requireAuth, async (req, res) => {
    const parsed = populationSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
    try {
      const { limit, offset } = parsePage(parsed.data, { defaultLimit: 50, maxLimit: 200 })
      const { count, passports } = await awareness.population({
        query: parsed.data.query, similarity: parsed.data.similarity, min_engagement: parsed.data.min_engagement,
      })
      // `total` is the cohort size (distinct matching customers); data is the page of passports.
      res.json(pageSlice(passports, { limit, offset, total: count }))
    } catch (err) {
      logger.error({ err }, 'population failed')
      res.status(500).json({ error: 'population failed' })
    }
  })

  router.get('/timeline/:passport_id', requireAuth, async (req, res) => {
    try {
      const { limit, offset } = parsePage(req.query, { defaultLimit: 50, maxLimit: 200 })
      const rows = await awareness.timeline({
        passport_id: req.params.passport_id,
        from:        req.query.from ? new Date(req.query.from) : null,
        to:          req.query.to   ? new Date(req.query.to)   : null,
        channels:    req.query.channels   ? String(req.query.channels).split(',')   : null,
        directions:  req.query.directions ? String(req.query.directions).split(',') : null,
        limit: limit + 1, offset,
      })
      res.json(page(rows, { limit, offset }))
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
  //   limit=20 / offset=0    — same pagination params as every other endpoint
  //
  // NOTE: context is the one structural exception to the uniform { data } envelope
  // — it returns a MAP of providers (crm, billing, …), not a single list — so it
  // carries the same limit/offset params but keeps a per-provider `has_more`.
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

      const { limit, offset } = parsePage(req.query, { defaultLimit: 20, maxLimit: 200 })

      if (!context?.collect) {
        return res.json({ providers: [], limit, offset, has_more: {}, context: {} })
      }

      const collected = await context.collect(req.params.passport_id, {
        providers: requested ?? undefined,
        limit,
        offset,
      })

      // has_more is a best-effort hint per array provider: if the slice came
      // back full it's likely there's another page. Object providers omit it.
      const has_more = {}
      for (const [name, value] of Object.entries(collected)) {
        if (Array.isArray(value)) has_more[name] = value.length === limit
      }

      res.json({
        providers: requested ?? allProviders,
        limit, offset, has_more,
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
  // a substantial concern on their own. /ask-population is its cohort sibling —
  // a grounded answer about the whole customer base (no passport_id).
  router.post('/ask', requireAuth, createAskHandler({ awareness, logger }))
  router.post('/ask-population', requireAuth, createAskPopulationHandler({ awareness, logger }))

  app.use('/analytics', router)
}
