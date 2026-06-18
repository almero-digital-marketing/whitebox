// /analytics/ask — HTTP wrapper around the core awareness.ask primitive.
//
// The grounded-synthesis logic (recall + context + prompt policy) lives in the
// awareness core (whitebox-server/src/awareness/ask.js) so it's shared, not
// owned by this plugin. This file is just validation + transport.

import { z } from 'zod'

export const askSchema = z.object({
  passport_id: z.string().uuid(),
  question:    z.string().min(1),
  limit:       z.number().int().positive().max(50).optional(),
})

export function createAskHandler({ awareness, logger }) {
  return async function ask(req, res) {
    const parsed = askSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
    try {
      res.json(await awareness.ask(parsed.data))
    } catch (err) {
      logger.error({ err }, 'ask failed')
      res.status(500).json({ error: 'ask failed' })
    }
  }
}

// Population scope: no passport_id — a grounded answer about the whole customer
// base (or a semantic cohort within it). Delegates to awareness.askPopulation.
export const askPopulationSchema = z.object({
  question:    z.string().min(1),
  similarity:  z.number().min(0).max(1).optional(),
  limit:       z.number().int().positive().max(10000).optional(),
})

export function createAskPopulationHandler({ awareness, logger }) {
  return async function askPopulation(req, res) {
    const parsed = askPopulationSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
    try {
      res.json(await awareness.askPopulation(parsed.data))
    } catch (err) {
      logger.error({ err }, 'ask-population failed')
      res.status(500).json({ error: 'ask-population failed' })
    }
  }
}
