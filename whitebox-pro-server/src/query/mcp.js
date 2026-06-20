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
      'Pass group: { by } to get a time-series / breakdown series [{ bucket, value }] instead — it buckets the ' +
      'selector.filter.metric aggregate by a time grain (hour/day/week/month) or a dimension ' +
      '(channel/direction/source/content); use it for trend + breakdown charts. ' +
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
      group:      z.object({ by: z.string() }).optional(),
    },
    handler: async ({ selector: sel = {}, ...opts }) => json(await selector.resolve(sel, opts)),
  })

  ctx.mcp.tool({
    name: 'whitebox.funnel',
    description:
      'Resolve an ordered, windowed FUNNEL over the people engine — { steps: [{ select, within? }], within? }. ' +
      'Each step is a selector resolved against the prior step\'s survivors, joined on matched_at: step k keeps only ' +
      'those whose qualifying event is AFTER step k-1\'s event and within step.within (the anchor advances). ' +
      'Returns a drop-off report (per-step count + conversion) plus per-step cohorts ("step:N") and gap cohorts ' +
      '("gap:N→M", split into pending = window still open vs dropped = window closed). Use it for "did A then B in ' +
      'time" — an unordered filter can\'t tell "in time" from "ever". Windowed steps must be deterministic (fact). ' +
      'Gap cohorts are the retargeting payoff (save them as audiences). `named` supplies reusable step selectors.',
    inputSchema: {
      funnel: z.object({
        within: z.string().optional(),
        steps: z.array(z.object({
          select: z.union([z.string(), selectorSchema]),
          within: z.string().optional(),
          name: z.string().optional(),
        })),
      }),
      named: z.record(z.string(), selectorSchema).optional(),
      asOf: z.string().optional(),
    },
    handler: async ({ funnel, named, asOf }) => json(await selector.funnel(funnel, { named, asOf })),
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
