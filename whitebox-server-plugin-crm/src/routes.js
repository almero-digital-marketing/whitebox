// HTTP routes for the crm plugin. Two write endpoints (records, facts) and
// one read endpoint (records by passport). All auth-gated. Schemas live
// here because they're only used by these routes.

import express from 'express'
import { z } from 'zod'
import { parsePage, page } from 'whitebox-server/pagination'

// Customer block — shared between records and facts. At least one of
// email / phone / external_id must resolve to an identity at ingest time,
// or the request is dropped with `202 no_identity`.
const customerSchema = z.object({
  email:       z.string().email().optional(),
  phone:       z.string().optional(),
  country:     z.string().length(2).optional(),
  external_id: z.union([z.string(), z.number()]).optional(),
})

// Structured state — upserted by (source, kind, external_id) into whitebox_crm_records.
const recordSchema = z.object({
  kind:        z.string().min(1).max(64),
  external_id: z.union([z.string(), z.number()]),
  status:      z.string().max(64).optional().nullable(),
  starts_at:   z.string().datetime().optional().nullable(),
  data:        z.record(z.any()).optional(),
})

const recordsRequestSchema = z.object({
  source:   z.string().min(1).max(64),
  customer: customerSchema,
  records:  z.array(recordSchema).min(1),
})

// Free-form things we know about the customer — fed to awareness as observations.
// May reference a record via `ref`, or stand alone for customer-level facts
// (tags, lifetime notes, preferences).
const factSchema = z.object({
  id:   z.union([z.string(), z.number()]),
  kind: z.string().min(1).max(64),
  body: z.string().min(1),
  ts:   z.string().datetime().optional(),
  ref:  z.object({
    kind:        z.string().min(1).max(64),
    external_id: z.union([z.string(), z.number()]),
  }).optional().nullable(),
})

const factsRequestSchema = z.object({
  source:   z.string().min(1).max(64),
  customer: customerSchema,
  facts:    z.array(factSchema).min(1),
})

// Client-reported observations (browser SDK). Passport-scoped, low-trust — no
// customer block (identity is the current passport), no bearer secret.
const observationSchema = z.object({
  id:   z.union([z.string(), z.number()]),
  kind: z.string().min(1).max(64),
  body: z.string().min(1),
  ts:   z.string().datetime().optional(),
  meta: z.record(z.any()).optional(),
})

export const observeSchema = z.object({
  observations: z.array(observationSchema).min(1),
})

export function mountRoutes(app, { requireAuth, records, ingest, logger }) {
  const router = express.Router()

  // `reason: no_identity` means well-formed payload, intentionally dropped at
  // ingest — sender bug, no retry. We surface that as 202 so the sender
  // doesn't queue retries for what is in fact a permanent decision.
  function respond(res, result) {
    if (result.reason === 'no_identity') return res.status(202).json(result)
    return res.json(result)
  }

  router.post('/records', requireAuth, async (req, res) => {
    const parsed = recordsRequestSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
    try {
      respond(res, await ingest.ingestRecords(parsed.data))
    } catch (err) {
      logger.error({ err }, 'CRM records ingest failed')
      res.status(500).json({ error: 'CRM records ingest failed' })
    }
  })

  router.post('/facts', requireAuth, async (req, res) => {
    const parsed = factsRequestSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
    try {
      respond(res, await ingest.ingestFacts(parsed.data))
    } catch (err) {
      logger.error({ err }, 'CRM facts ingest failed')
      res.status(500).json({ error: 'CRM facts ingest failed' })
    }
  })

  // Client-reported observations. NOT bearer-authed — a browser can't hold the
  // secret. Identity is the explicit passport_id (same trust model as the
  // engagement events fallback); the socket path in index.js is preferred since
  // it takes the passport from the authenticated connection. Recorded low-trust.
  router.post('/observe', async (req, res) => {
    const parsed = observeSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
    try {
      respond(res, await ingest.ingestObservations({
        passport_id: req.body?.passport_id,
        observations: parsed.data.observations,
      }))
    } catch (err) {
      logger.error({ err }, 'CRM observe ingest failed')
      res.status(500).json({ error: 'CRM observe ingest failed' })
    }
  })

  router.get('/records/:passport_id', requireAuth, async (req, res) => {
    try {
      const { limit, offset } = parsePage(req.query, { defaultLimit: 50, maxLimit: 500 })
      const rows = await records.listForPassport(req.params.passport_id, {
        source: req.query.source,
        kind:   req.query.kind,
        limit:  limit + 1,   // one extra → has_more without a COUNT
        offset,
      })
      res.json(page(rows, { limit, offset }))
    } catch (err) {
      logger.error({ err }, 'CRM records listing failed')
      res.status(500).json({ error: 'CRM records listing failed' })
    }
  })

  app.use('/crm', router)
}
