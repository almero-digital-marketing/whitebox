// Evaluator — turns a rule + a passport into a verdict by ASSEMBLING three
// feature families and letting the LLM judge over them:
//
//   semantic  (meaning)  — recalled awareness evidence + vector-narrow candidates
//   metric    (math)     — deterministic SQL aggregates over exposures
//   crm       (state)    — generic facts from the context registry
//
// The LLM judges *meaning*; it never counts (metric does) or invents state (crm
// does). Output is structured { match, score, reason }. See docs/04-evaluator.md.

import { z } from 'zod'
import * as semantic from './features/semantic.js'
import * as metric from './features/metric.js'
import * as crm from './features/crm.js'

const VERDICT = z.object({
  match:  z.boolean(),
  score:  z.number().min(0).max(1),
  reason: z.string(),
})

const DRAFT = z.object({
  name:      z.string(),
  seed:      z.string(),
  criteria:  z.string(),
  threshold: z.number().min(0).max(1),
  ttl_days:  z.number().int().positive(),
  requires:  z.object({
    semantic: z.array(z.string()),
    metric:   z.array(z.any()),
    crm:      z.array(z.string()),
  }),
})

let ai, config, logger, store

export function init(deps) {
  ai = deps.ai
  config = deps.config || {}
  logger = deps.logger
  store = deps.store
  semantic.init({ awareness: deps.awareness })
  metric.init({ db: deps.db })
  crm.init({ context: deps.context, store: deps.store })
}

// Candidate passports for a rule (cheap vector-narrow). See docs/04.
export function candidates(rule) {
  return semantic.candidates(rule, {
    similarity: config.candidateSimilarity ?? 0.72,
    limit: config.candidateLimit ?? 2000,
  })
}

// Full verdict for one passport. Hard metric/crm gates run BEFORE the LLM so we
// never pay for an LLM call on someone who structurally can't qualify.
export async function evaluate(rule, passportId) {
  const reqs = rule.requires || {}

  const m = await metric.evaluate(passportId, reqs.metric || [])
  if (!m.pass) return verdict(false, 0, 'metric gate not met', { metric: m.values })

  const facts = (reqs.crm?.length) ? await crm.facts(passportId) : {}
  if ((reqs.crm || []).some(k => facts[k] == null)) {
    return verdict(false, 0, `missing required crm fact(s): ${(reqs.crm || []).filter(k => facts[k] == null).join(', ')}`,
      { facts })
  }

  const evidence = await semantic.evidence(rule, passportId)
  const judged = await judge(rule, { evidence, metric: m.values, facts })
  const qualified = judged.match && judged.score >= rule.threshold
  return verdict(qualified, judged.score, judged.reason, { evidence, metric: m.values, facts })
}

// LLM judge with structured output via the core ai.object facade — the model
// returns an object validated against VERDICT, no JSON-parsing.
async function judge(rule, { evidence, metric: metrics, facts }) {
  const system = `You decide if a person matches an audience rule, based ONLY on the evidence provided.
- "score" is your confidence (0..1) the person matches the rule.
- "reason" cites the concrete evidence (channel + what they did). Do not invent facts.
- The numeric "metrics" and "facts" are already true; weigh them, don't recompute.`
  const user = JSON.stringify({ rule: { criteria: rule.criteria }, evidence, metrics, facts }, null, 2)
  try {
    const v = await ai.object(system, user, VERDICT)
    return { match: !!v.match, score: Number(v.score) || 0, reason: String(v.reason || '') }
  } catch (err) {
    logger?.warn?.({ err }, 'audiences: judge failed')
    return { match: false, score: 0, reason: 'judge error' }
  }
}

const verdict = (qualified, score, reason, evidence) => ({ qualified, score, reason, evidence })

// Dry-run a rule against a SAMPLE of its candidates → projected matches, sample
// reasons, estimated cost, and requires-availability. Never fires anything.
export async function preview(rule, { sample = 50 } = {}) {
  const requiresReport = await reportRequires(rule)
  const cand = [...await candidates(rule)]
  const take = cand.slice(0, sample)
  const results = []
  for (const pid of take) results.push({ passport_id: pid, ...(await evaluate(rule, pid)) })

  const matched = results.filter(r => r.qualified)
  const rate = take.length ? matched.length / take.length : 0
  return {
    candidate_pool: cand.length,
    sampled: take.length,
    est_matches: Math.round(cand.length * rate),
    est_full_eval_cost: estCost(cand.length),
    requires: requiresReport,
    sample_reasons: matched.slice(0, 5).map(r => r.reason),
  }
}

// Validate that each `requires` family is actually available for this tenant.
export async function reportRequires(rule) {
  const out = { semantic: 'ok', metric: 'ok', crm: 'ok', warnings: [] }
  const need = rule.requires?.crm || []
  if (need.length) {
    const have = new Set((await crm.availableKeys()).map(k => k.key))
    const missing = need.filter(k => !have.has(k))
    if (missing.length) {
      out.crm = 'missing'
      out.warnings.push(`No CRM facts seen for: ${missing.join(', ')} — rule will under-match until ingested.`)
    }
  }
  return out
}

function estCost(n) {
  const perEval = 0.0006 // rough $/eval for the screen model; tune to your model
  return `$${(n * perEval).toFixed(2)}`
}

// CRM fact keys the tenant has ever sent (for rule authoring + discovery).
export const availableFacts = () => crm.availableKeys()

// Draft a structured rule from a natural-language description (MCP draft_rule).
export async function draftRule(description) {
  const system = `Turn a marketer's audience description into a draft rule.
- "seed": short comma-separated topics for a semantic search.
- "criteria": one precise sentence the AI will judge against.
- Put topical intent in requires.semantic, counts/recency in requires.metric, CRM state in requires.crm.
- Default threshold 0.7 and ttl_days 30 unless the description implies otherwise.`
  return ai.object(system, description, DRAFT)
}
