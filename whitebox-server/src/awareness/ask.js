// Ask — grounded synthesis over a single passport's awareness. Pulls structured
// context (CRM rows, … via the context registry) and semantic evidence (recall)
// in parallel, formats them into a grounded prompt, and asks the AI to answer.
//
// This is the reusable reasoning primitive that sits next to recall/population.
// The analytics plugin exposes it over HTTP/MCP; any other consumer (a summary
// tool, a rule evaluator) can call it directly without depending on a plugin.
//
// The default system prompt below is the policy for how whitebox answers about a
// customer — treat changes to it as you would a contract. Callers may override
// it with `instruction`, and request structured output with `schema` (Zod).
//
// Module-level singleton (init), matching the rest of core.

let ai
let context
let recall

export function init(deps) {
  ai = deps.ai
  context = deps.context     // the context registry (optional) — { collect }
  recall = deps.recall       // (args) => hits   — awareness semantic recall
}

export const ASK_SYSTEM_PROMPT = [
  'You answer questions about a single customer\'s content history with this company.',
  '',
  'You may be given two kinds of context:',
  '  1. Structured context — current state from external systems (CRM, billing, ...).',
  '     Each entry is one row with kind, status, dates, and a free-form data object.',
  '     This represents what is TRUE RIGHT NOW about the customer.',
  '  2. Evidence — semantically-recalled chunks of content the customer was exposed',
  '     to or expressed, tagged with timestamp, channel (mail/voip/web/crm),',
  '     direction (exposure/expression/conversation/observation), and — when',
  '     available — UTM attribution showing how they arrived.',
  '     This represents WHAT WE HAVE SEEN over time.',
  '',
  'Rules:',
  '- Ground every claim in the context provided. Do not invent facts.',
  '- Prefer structured context for current state ("they have an active subscription").',
  '- Prefer evidence for historical or qualitative claims ("they asked about pricing on...").',
  '- Cite timestamps for evidence (ISO date, abbreviated to date or date+time).',
  '- Mention UTM attribution when it is relevant to the question.',
  '- If UTMs are absent for an exposure, do not invent attribution. Some content arrives without campaign attribution; that is normal.',
  '- Distinguish "exposure" (we showed/sent it) from "expression" (the user said/wrote it) from "observation" (an external system told us).',
  '- If neither context supports a clear answer, say so plainly.',
  '- Be concise. No preamble. No "Based on the evidence...".',
].join('\n')

// Render the { [providerName]: data } blob from context.collect() into a flat
// human-readable section for the LLM. Each provider is free-form, so we YAML-ish
// it — newline-separated entries, indented sub-fields.
export function formatStructuredContext(structured) {
  if (!structured || typeof structured !== 'object') return ''
  const sections = []
  for (const [name, value] of Object.entries(structured)) {
    if (value == null) continue
    if (Array.isArray(value) && value.length === 0) continue
    sections.push(`${name}:`)
    if (Array.isArray(value)) {
      for (const item of value) sections.push('  - ' + JSON.stringify(item))
    } else {
      sections.push('  ' + JSON.stringify(value))
    }
  }
  return sections.join('\n')
}

export function formatHitsAsEvidence(hits) {
  return hits.map(h => {
    const utm = [h.utm_source, h.utm_medium, h.utm_campaign].filter(Boolean).join(' / ')
    const referrer = h.referrer ? ` referrer=${h.referrer}` : ''
    const attribution = utm
      ? ` [arrived via: ${utm}${referrer}]`
      : (h.referrer ? ` [referrer: ${h.referrer}]` : '')
    const ts = h.ts instanceof Date ? h.ts.toISOString() : h.ts
    const channel = h.channel || '?'
    const direction = h.direction || '?'
    return `[${ts}] ${channel}/${direction}${attribution}\n${h.chunk_text}`
  }).join('\n---\n')
}

// ask({ passport_id, question, limit?, instruction?, schema? })
//   instruction — override ASK_SYSTEM_PROMPT (default policy) for the system role.
//   schema      — Zod schema → structured output; returns the validated object
//                 merged with { evidence, context } instead of { answer }.
export async function ask({ passport_id, question, limit = 10, instruction, schema } = {}) {
  const [structured, hits] = await Promise.all([
    context?.collect ? context.collect(passport_id, { question, limit: 20 }) : Promise.resolve({}),
    recall({ passport_id, query: question, limit }),
  ])

  const structuredBlock = formatStructuredContext(structured)
  const hasStructured = structuredBlock.length > 0

  // Short-circuit only when BOTH sources are empty — and only for prose answers.
  // A schema/verdict caller still wants a structured result (typically a
  // negative match), so let it run.
  if (!hits.length && !hasStructured && !schema) {
    return {
      answer: 'No relevant content found in this customer\'s history.',
      evidence: [],
      context: structured,
    }
  }

  const evidence = formatHitsAsEvidence(hits)
  const sections = []
  if (hasStructured) sections.push(`Structured context:\n${structuredBlock}`)
  if (evidence)      sections.push(`Evidence:\n${evidence}`)
  sections.push(`Question: ${question}`)

  const system = instruction || ASK_SYSTEM_PROMPT
  const user = sections.join('\n\n')

  if (schema) {
    const result = await ai.object(system, user, schema)
    return { ...result, evidence: hits, context: structured }
  }
  const answer = await ai.prompt(system, user)
  return { answer, evidence: hits, context: structured }
}
