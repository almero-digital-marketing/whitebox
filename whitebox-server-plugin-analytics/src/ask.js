// /analytics/ask — the LLM synthesis endpoint.
//
// Pulls structured context (CRM rows, future billing/support/...) and
// semantic evidence (awareness chunks) in parallel, formats them into a
// grounded prompt, and asks the LLM to synthesize. The system prompt below
// is the entire policy document for how whitebox answers questions about
// a customer; treat changes to it as you would changes to a contract.

import { z } from 'zod'

export const askSchema = z.object({
  passport_id: z.string().uuid(),
  question:    z.string().min(1),
  limit:       z.number().int().positive().max(50).optional(),
})

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

// Render the { [providerName]: data } blob from context.collect() into a
// flat human-readable section for the LLM. Each provider is free-form, so
// we YAML-ish it — newline-separated entries, indented sub-fields.
export function formatStructuredContext(context) {
  if (!context || typeof context !== 'object') return ''
  const sections = []
  for (const [name, value] of Object.entries(context)) {
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

// Pure-function variant — same logic as the HTTP handler but returns the
// `{ answer, evidence, context }` object directly. Used by the MCP `whitebox.ask`
// tool and by the HTTP handler below; the only difference is who handles the
// transport / error response.
export async function runAsk({ passport_id, question, limit = 10 }, { awareness, ai, context }) {
  const [structured, hits] = await Promise.all([
    context?.collect ? context.collect(passport_id, { question, limit: 20 }) : Promise.resolve({}),
    awareness.recall({ passport_id, query: question, limit }),
  ])

  const structuredBlock = formatStructuredContext(structured)
  const hasStructured = structuredBlock.length > 0

  // Short-circuit only when BOTH sources are empty. Structured context
  // alone can answer "do they have an active subscription?" even with
  // zero awareness chunks.
  if (!hits.length && !hasStructured) {
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

  const answer = await ai.prompt(ASK_SYSTEM_PROMPT, sections.join('\n\n'))
  return { answer, evidence: hits, context: structured }
}

// Express handler factory. Closes over the deps and wraps runAsk with
// validation + transport.
export function createAskHandler({ awareness, ai, context, logger }) {
  return async function ask(req, res) {
    const parsed = askSchema.safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() })
    try {
      res.json(await runAsk(parsed.data, { awareness, ai, context }))
    } catch (err) {
      logger.error({ err }, 'ask failed')
      res.status(500).json({ error: 'ask failed' })
    }
  }
}
