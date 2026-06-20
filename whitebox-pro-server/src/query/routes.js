import { z } from 'zod'

// HTTP surface for the core query engine (docs/selector.md §13). QUERY is a
// *core* surface — apps resolve a selector directly against core, no plugin in
// the path. Two endpoints, both auth-gated:
//
//   POST /query    → resolve a selector into a projection (people | knowledge)
//   POST /preview  → cost metadata for a people query, before you run/save (§9)
//
// `/ask` (NL answer = a layer *over* QUERY(knowledge) + synthesis) is a separate
// REST-only surface and lands in its own increment. There is deliberately no MCP
// equivalent of /ask — see mcp.js.

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
})

const previewSchema = z.object({
  selector:   selectorShape.default({}),
  projection: z.enum(['people']).optional(),   // preview is a people cost gate (§9)
  scope:      z.union([z.string(), z.array(z.string())]).optional(),
  asOf:       z.string().optional(),
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

// /query and /preview are siblings (§13), not nested — body parsing is the app's
// global express.json(), same as every other core/plugin route.
export function mountRoutes(app, { requireAuth, selector, logger, queryPath = '/query', previewPath = '/preview' }) {
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
}
