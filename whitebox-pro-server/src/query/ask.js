// `/ask` — the natural-language answer layer (docs/selector.md §7, §13).
//
// answer = synthesize(question, QUERY(…, knowledge)). It RETRIEVES through the
// selector engine's `knowledge` projection (about + filter over BOTH memories),
// then asks the LLM to write prose grounded in that evidence. This is the one
// place the engine's output meets a generator — and it lives strictly *above* the
// engine: REST-only, never an MCP tool (an MCP client is already an LLM and does
// its own synthesis from `knowledge`).

const SYSTEM = [
  'You answer questions grounded ONLY in the evidence provided. Each evidence item is a',
  'piece of a customer\'s content history, formatted as: [channel/direction @ date] text.',
  '- Cite the evidence (channel + date) for historical or qualitative claims.',
  '- Distinguish "exposure" (we showed/sent it) from "expression" (the customer said/wrote',
  '  it) from "observation" (an external system recorded it). Weight expressions and',
  '  observations as what the customer actually cares about; passive exposure is weak signal.',
  '- If the evidence does not support a clear answer, say so plainly — do not invent facts.',
  '- Be concise. No preamble, no "Based on the evidence…".',
].join('\n')

const NO_EVIDENCE = 'I don\'t have any relevant content to answer that.'

function evidenceLine(e) {
  const when = e.observed_at ? new Date(e.observed_at).toISOString().slice(0, 10) : '?'
  return `- [${e.channel || '?'}/${e.direction || '?'} @ ${when}] ${e.content ?? ''}`
}

function userPrompt(question, evidence) {
  return `Question: ${question}\n\nEvidence:\n${evidence.map(evidenceLine).join('\n')}`
}

// answer({ selector, question, scope, passport, asOf, limit }, { resolve, ai })
//   → { answer, evidence }
// `about` defaults to the question, so a bare question still drives retrieval.
// Empty evidence short-circuits — no LLM call, an honest "nothing found".
export async function answer({ selector = {}, question, scope, passport, asOf, limit } = {}, { resolve, ai } = {}) {
  if (!question || typeof question !== 'string') throw new Error('selector: ask needs a `question`')
  if (!resolve || !ai?.prompt) throw new Error('selector: ask requires the selector + ai modules')

  const sel = { ...selector, about: selector.about ?? question }
  const knowledge = await resolve(sel, { projection: 'knowledge', scope, passport, asOf, limit })
  const evidence = knowledge?.evidence || []
  if (!evidence.length) return { answer: NO_EVIDENCE, evidence: [] }

  const text = await ai.prompt(SYSTEM, userPrompt(question, evidence))
  return { answer: text, evidence }
}
