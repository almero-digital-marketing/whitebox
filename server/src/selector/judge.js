import { z } from 'zod'

// The `judge` stage — an LLM predicate over the candidates that survived
// `about` + `filter`. It decides *membership* (a boolean + confidence), never
// generates prose; answering is a layer above the engine. See docs/selector.md §6.
// Runs LAST, so cost is bounded by how much about + filter already narrowed.

const VERDICT = z.object({
  match: z.boolean(),
  score: z.number().min(0).max(1),
  reason: z.string().default(''),
})

const SYSTEM = `You decide whether a person matches an audience rule, based ONLY on the evidence provided.
- "match": do they match the rule?
- "score": your confidence (0..1).
- "reason": cite the concrete evidence (channel + what they did). Do not invent facts.`

function userPrompt(criteria, evidence) {
  const lines = (evidence || []).map(e => `- [${e.channel || '?'}/${e.direction || '?'}] ${e.text ?? ''}`).join('\n')
  return `Rule: ${criteria}\n\nEvidence:\n${lines || '(none)'}`
}

// Run the judge over `candidates` (passport ids) → confirmed survivors
// [{ id, score, reason }]. Bounded concurrency; a judge/evidence error drops the
// candidate (conservative — an unconfirmed person is not added to an audience).
export async function evaluate(candidates, judge, { ai, evidenceFor, concurrency = 6 } = {}) {
  const { criteria, confidence = 0.7 } = judge || {}
  if (!criteria) throw new Error('selector.judge: needs `criteria`')
  if (!ai?.object) throw new Error('selector.judge: requires the ai module')

  const survivors = []
  let i = 0
  async function worker() {
    while (i < candidates.length) {
      const id = candidates[i++]
      let v
      try {
        const evidence = await evidenceFor(id)
        v = await ai.object(SYSTEM, userPrompt(criteria, evidence), VERDICT)
      } catch {
        continue
      }
      if (v?.match && v.score >= confidence) survivors.push({ id, score: v.score, reason: v.reason })
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) || 1 }, worker))
  return survivors
}
