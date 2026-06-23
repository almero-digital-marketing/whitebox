import { z } from 'zod'
import * as ask from './ask.js'

// HTTP surface for the core query engine (docs/selector.md §13). QUERY is a
// *core* surface — apps resolve a selector directly against core, no plugin in
// the path. Three endpoints, all auth-gated:
//
//   POST /query    → resolve a selector into a projection (people | knowledge)
//   POST /preview  → cost metadata for a people query, before you run/save (§9)
//   POST /ask      → NL answer = QUERY(knowledge) + LLM synthesis (§7) — REST only
//   POST /funnel   → ordered windowed steps → drop-off report + step/gap cohorts (§14)
//
// There is deliberately no MCP equivalent of /ask — see mcp.js.

// The selector grammar itself (recursive filter tree, fact/metric ops) is
// validated by the engine, which throws precise `selector: …` errors; here we
// only bound the envelope so a malformed request 400s cleanly.
const selectorShape = z.object({
  about:  z.union([z.string(), z.object({}).passthrough()]).optional(),
  filter: z.any().optional(),
  judge:  z.object({}).passthrough().optional(),
}).passthrough()

const querySchema = z.object({
  selector:   selectorShape.default({}),
  projection: z.enum(['people', 'knowledge']).optional(),
  scope:      z.union([z.string(), z.array(z.string())]).optional(), // people: id[]; knowledge: "passport"
  passport:   z.string().optional(),                                 // knowledge·passport
  asOf:       z.string().optional(),
  limit:      z.number().int().positive().max(1000).optional(),
  group:      z.object({ by: z.string(), limit: z.number().int().positive().max(1000).optional() }).optional(), // §7 — time-series / breakdown (limit = top-N guardrail for high-card keys)
})

const previewSchema = z.object({
  selector:   selectorShape.default({}),
  projection: z.enum(['people']).optional(),   // preview is a people cost gate (§9)
  scope:      z.union([z.string(), z.array(z.string())]).optional(),
  asOf:       z.string().optional(),
})

const askSchema = z.object({
  question: z.string().min(1),
  selector: selectorShape.optional(),          // optional about/filter narrowing; about defaults to the question
  scope:    z.union([z.string(), z.array(z.string())]).optional(),
  passport: z.string().optional(),
  asOf:     z.string().optional(),
  limit:    z.number().int().positive().max(100).optional(),
})

const funnelSchema = z.object({
  funnel: z.object({
    within: z.string().optional(),
    steps:  z.array(z.object({
      select: z.union([z.string(), selectorShape]),   // inline selector or a name into `named`
      within: z.string().optional(),
      name:   z.string().optional(),
    })).min(1),
  }),
  named: z.record(z.string(), selectorShape).optional(),   // named selectors steps can reference
  asOf:  z.string().optional(),
})

// Our deliberate, user-facing engine throws all start with "selector:" — those
// are bad-request (the selector was syntactically ok but semantically rejected),
// not server faults. Anything else (a DB error, say) is a real 500.
function sendEngineError(res, logger, err, where) {
  if (typeof err?.message === 'string' && err.message.startsWith('selector')) {
    return res.status(400).json({ error: err.message })
  }
  logger.error({ err }, `${where} failed`)
  return res.status(500).json({ error: `${where} failed` })
}

// /query, /preview and /ask are siblings (§13), not nested — body parsing is the
// app's global express.json(), same as every other core/plugin route. `ai` is
// only needed by /ask (synthesis); /query and /preview never touch it.
export function mountRoutes(app, { requireAuth, selector, ai, logger, queryPath = '/query', previewPath = '/preview', askPath = '/ask', funnelPath = '/funnel' }) {
  app.post(queryPath, requireAuth, async (req, res) => {
    const parsed = querySchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
    const { selector: sel, ...opts } = parsed.data
    try {
      res.json(await selector.resolve(sel, opts))
    } catch (err) {
      sendEngineError(res, logger, err, 'query')
    }
  })

  app.post(previewPath, requireAuth, async (req, res) => {
    const parsed = previewSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
    const { selector: sel, ...opts } = parsed.data
    try {
      res.json(await selector.preview(sel, opts))
    } catch (err) {
      sendEngineError(res, logger, err, 'preview')
    }
  })

  app.post(askPath, requireAuth, async (req, res) => {
    const parsed = askSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
    try {
      res.json(await ask.answer(parsed.data, { resolve: selector.resolve, ai }))
    } catch (err) {
      sendEngineError(res, logger, err, 'ask')
    }
  })

  app.post(funnelPath, requireAuth, async (req, res) => {
    const parsed = funnelSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
    const { funnel, named, asOf } = parsed.data
    try {
      res.json(await selector.funnel(funnel, { named, asOf }))
    } catch (err) {
      sendEngineError(res, logger, err, 'funnel')
    }
  })
}
