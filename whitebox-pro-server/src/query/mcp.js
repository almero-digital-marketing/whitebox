import { z } from 'zod'

// MCP surface for the core query engine (docs/selector.md §7, §13). Two tools —
// `whitebox.query` and `whitebox.preview` — the exact REST surface, tuned for an
// LLM agent.
//
// There is deliberately NO `ask` tool. An MCP client is already an LLM agent, so
// it retrieves `knowledge` (evidence) and writes the answer in its OWN context —
// the engine never generates prose (§7, "answer is a layer on top"). The `query`
// tool description says so explicitly, so the agent knows the contract.

const selectorSchema = z.object({
  about:  z.union([z.string(), z.object({}).passthrough()]).optional(),
  filter: z.any().optional(),
  judge:  z.object({ criteria: z.string(), confidence: z.number().min(0).max(1).optional() }).passthrough().optional(),
}).passthrough()

const json = obj => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] })

export function registerMcp(ctx, { selector }) {
  if (!ctx.mcp) return

  ctx.mcp.tool({
    name: 'whitebox.query',
    description:
      'Retrieve from the two memories (semantic awareness + structured facts) with a selector { about, filter, judge }. ' +
      'Two projections: "knowledge" returns ranked evidence (content chunks) for a passport or the whole base; ' +
      '"people" returns the matching cohort { count, passports }. ' +
      'about = semantic narrow (gates people / ranks knowledge); filter = a boolean tree of fact + metric clauses; ' +
      'judge = an LLM membership predicate (people only). asOf time-travels the deterministic filter. ' +
      'This tool RETRIEVES — it never writes prose. To answer a natural-language question, query "knowledge" and ' +
      'synthesize the answer yourself from the returned evidence (there is no ask tool by design). ' +
      'For people, run whitebox.preview first to see the judge cost.',
    inputSchema: {
      selector:   selectorSchema.optional(),
      projection: z.enum(['people', 'knowledge']).optional(),
      scope:      z.union([z.string(), z.array(z.string())]).optional(),
      passport:   z.string().optional(),
      asOf:       z.string().optional(),
      limit:      z.number().int().positive().max(1000).optional(),
    },
    handler: async ({ selector: sel = {}, ...opts }) => json(await selector.resolve(sel, opts)),
  })

  ctx.mcp.tool({
    name: 'whitebox.preview',
    description:
      'Estimate the cost of a "people" selector BEFORE running or saving it as an audience. Cheap (no full judge run): ' +
      'returns the about cohort size, the filter survivors (= exactly the LLM judge-call count), a full-scan flag when ' +
      'the filter has no positive anchor, and — when a judge is present — a sampled qualifying rate + projected match ' +
      'count + a few real reasons. confirmRequired is set when survivors exceed the safety cap. ' +
      'Always preview a judged audience first so the judge never sweeps an unbounded set by accident.',
    inputSchema: {
      selector:   selectorSchema.optional(),
      projection: z.enum(['people']).optional(),
      scope:      z.union([z.string(), z.array(z.string())]).optional(),
      asOf:       z.string().optional(),
    },
    handler: async ({ selector: sel = {}, ...opts }) => json(await selector.preview(sel, opts)),
  })
}
