// Evaluator — now a thin adapter over the core selector engine (ctx.selector).
// The engine owns ALL selection (about → filter → judge over the two memories);
// this module just maps a rule's saved `select` onto it. The old bespoke feature
// families (semantic / metric / crm) and the LLM judge are gone — they were a
// re-implementation of exactly this funnel. See docs/04-evaluator.md.

import { z } from 'zod'

// A drafted rule (audiences_draft_rule): the LLM proposes a selector-shaped rule.
const DRAFT = z.object({
  name: z.string(),
  select: z.object({
    about: z.string().optional(),
    judge: z.object({
      criteria: z.string(),
      confidence: z.number().min(0).max(1).optional(),
    }).optional(),
  }),
})

let selector, ai, db, logger

export function init(deps) {
  selector = deps.selector
  ai = deps.ai
  db = deps.db
  logger = deps.logger
}

const verdict = (qualified, score, reason, evidence) => ({ qualified, score, reason, evidence })

// The rule's QUALIFIED cohort, with per-member metadata — for population eval +
// keep-warm. The engine resolves the whole cohort (judge included) in ONE call,
// so there's no candidates-then-judge-each double pass.
//   · select source → the people resolve (carries why / score / matched_at)
//   · funnel source → the funnel slot cohort (a step's completers or a gap)
export async function resolveCohort(rule) {
  if (rule.funnel) {
    const result = await selector.funnel(rule.funnel, {})
    const ids = selector.funnelSlot(result, rule.slot, { status: rule.status })
    return ids.map(id => ({ id, qualified: true, score: 1, reason: `funnel ${rule.slot}`, evidence: { slot: rule.slot, status: rule.status } }))
  }
  const res = await selector.resolve(rule.select, { projection: 'people' })
  return res.passports.map(p => ({
    id: p.id, qualified: true, score: p.score ?? 1, reason: p.why ?? 'matched the selector',
    evidence: p.matched_at ? { matched_at: p.matched_at } : {},
  }))
}

// Membership of ONE passport (the dirty/incremental path) — SELECT sources only.
// A funnel is inherently a population computation, so funnel audiences keep warm
// by population re-resolve (resolveCohort), never per-passport.
export async function evaluate(rule, passportId) {
  if (rule.funnel) return verdict(false, 0, 'funnel audiences evaluate by population (keep-warm), not per-passport', { funnel: true })
  const res = await selector.resolve(rule.select, { projection: 'people', scope: [passportId] })
  const hit = res.passports.find(p => p.id === passportId)
  if (!hit) return verdict(false, 0, 'did not match the selector', {})
  return verdict(true, hit.score ?? 1, hit.why ?? 'matched the selector', { matched_at: hit.matched_at })
}

// Cost preview — never fires. select → the engine's preview (cohort, judge-call
// count, sampled rate + reasons, full-scan flag); funnel → the slot cohort size.
export async function preview(rule /*, { sample } */) {
  if (rule.funnel) {
    const cohort = await resolveCohort(rule)
    return { candidate_pool: cohort.length, est_matches: cohort.length, sampled: 0, full_scan: false, confirm_required: false, sample_reasons: [], source: rule.slot }
  }
  const p = await selector.preview(rule.select, {})
  return {
    candidate_pool: p.filter.survivors,
    est_matches: p.judge ? p.judge.projectedMatches : p.filter.survivors,
    sampled: p.judge?.sample ?? 0,
    full_scan: p.fullScan,
    confirm_required: p.confirmRequired,
    sample_reasons: p.judge?.reasons ?? [],
  }
}

// Fact keys the base has — for rule authoring + discovery (was a bespoke cache;
// now read straight from core facts).
export async function availableFacts() {
  const rows = await db('whitebox_facts').distinct('key').orderBy('key')
  return rows.map(r => ({ key: r.key }))
}

// A segment's source ({ select } | { funnel, slot, status }) is rule-shaped, so the
// existing rule resolution/preview apply unchanged — these aliases just name the intent.
export const resolveSource = source => resolveCohort(source)
export const previewSource = source => preview(source)

// --- audiences: a boolean COMPOSITION of segments (AND / OR / NOT) ---
// We own only the set combination; the caller passes `resolveSegment(id) → Set<id>`
// (the service has the segment store). Set algebra works uniformly across select and
// funnel-slot segments — each resolves to a cohort, then op combines them and any
// negated member is subtracted. `all` → intersect positives, `any` → union positives.
const union = sets => { const out = new Set(); for (const s of sets) for (const id of s) out.add(id); return out }
const intersect = (sets) => {
  if (!sets.length) return new Set()
  let acc = sets[0]
  for (let i = 1; i < sets.length; i++) { const s = sets[i], next = new Set(); for (const id of acc) if (s.has(id)) next.add(id); acc = next }
  return new Set(acc)
}
async function composeAudience(rule, resolveSegment) {
  const positives = rule.members.filter(m => !m.negate)
  const negatives = rule.members.filter(m => m.negate)
  const posSets = await Promise.all(positives.map(m => resolveSegment(m.segment)))
  const result = rule.op === 'any' ? union(posSets) : intersect(posSets)
  if (negatives.length) {
    const exclude = union(await Promise.all(negatives.map(m => resolveSegment(m.segment))))
    for (const id of exclude) result.delete(id)
  }
  return result
}
export const resolveAudience = async (rule, resolveSegment) => [...(await composeAudience(rule, resolveSegment))]
export const previewAudience = async (rule, resolveSegment) => {
  const ids = await composeAudience(rule, resolveSegment)
  return { candidate_pool: ids.size, est_matches: ids.size }
}

// Name a chart-derived segment in a few words. `context` carries what the user
// selected (chart kind, dimension, bucket, widget title) so the label is specific.
const SEG_NAME = z.object({ name: z.string() })
export async function nameSegment({ source, context }) {
  const system = `Name a marketing audience SEGMENT — a slice of customers — in 2 to 5 words.
Title Case, no quotes, no trailing punctuation. Be specific and human, using the context
(e.g. "Lapsed VIP Clients", "Opened, Didn't Click"). Do NOT use the word "segment" or restate raw field names.`
  try {
    const r = await ai.object(system, JSON.stringify({ context: context || null, source }), SEG_NAME)
    return r?.name?.trim() || fallbackName(source, context)
  } catch (err) {
    logger?.warn?.({ err }, 'audiences: nameSegment failed')
    return fallbackName(source, context)
  }
}
function fallbackName(source, context) {
  if (context?.label) return String(context.label)
  if (source?.funnel) return `Funnel ${source.slot}${source.status ? ' · ' + source.status : ''}`
  return 'Segment'
}

// Name an AUDIENCE from its composition (the included/excluded segment names + the
// match mode). Used while the user hasn't named it themselves.
const AUD_NAME = z.object({ name: z.string() })
export async function nameAudience({ op, included = [], excluded = [] }) {
  const system = `Name a marketing AUDIENCE in 2 to 5 words. Title Case, no quotes, no trailing
punctuation. It combines customer segments: it matches ${op === 'any' ? 'ANY of' : 'ALL of'} the
"include" segments${excluded.length ? ', then excludes the "exclude" segments' : ''}. Be specific and
human (e.g. "Lapsed High-Value", "Everyone Except Reached"). Do NOT use the words "audience" or "segment".`
  try {
    const r = await ai.object(system, JSON.stringify({ match: op, include: included, exclude: excluded }), AUD_NAME)
    return r?.name?.trim() || fallbackAudienceName(included, excluded)
  } catch (err) {
    logger?.warn?.({ err }, 'audiences: nameAudience failed')
    return fallbackAudienceName(included, excluded)
  }
}
function fallbackAudienceName(included, excluded) {
  const base = included.join(' + ') || 'Audience'
  return (excluded.length ? `${base} except ${excluded.join(', ')}` : base).slice(0, 60)
}

// Draft a selector-shaped rule from a natural-language description.
export async function draftRule(description) {
  const system = `Turn a marketer's audience description into a draft audience rule.
- "name": a short human label.
- "select.about": a few comma-separated topics for a semantic search (omit if purely structural).
- "select.judge.criteria": one precise sentence the AI judges membership against (omit if purely structural).
- "select.judge.confidence": 0..1 (default 0.7).
Return only the fields you're confident about; structural fact/metric filters are added by hand after.`
  return ai.object(system, description, DRAFT)
}
