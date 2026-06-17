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
let population
let populationStats
let sampleContent

export function init(deps) {
  ai = deps.ai
  context = deps.context                  // the context registry (optional) — { collect }
  recall = deps.recall                    // (args) => hits   — per-passport semantic recall
  population = deps.population             // (args) => { count, passports } — cohort recall
  populationStats = deps.populationStats   // () => { customers, exposures, breakdown } — base aggregates
  sampleContent = deps.sampleContent       // (args) => rows   — query-independent base sample
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
  '     direction (exposure/expression/conversation/observation), reading depth for',
  '     web reads (glance/read/deep), and — when available — UTM attribution.',
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
  '- Weight by reading depth and intent. A "glance" (a skimmed heading or brief look) or a passively-viewed image is weak, incidental signal — do NOT present it as a stated interest. Treat genuine reads ("read"/"deep") and active signals (expressions, conversations, observations — they asked, called, clicked, or a system recorded it) as what the customer actually cares about. Scrolling past content on a page is exposure, not interest.',
  '- When asked what a customer is interested in, lead with what they genuinely engaged with; mention skimmed/glanced topics only as incidental ("briefly glanced at…"), if at all.',
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
    // Reading depth (web text only): a 'glance' is a skimmed heading/brief look,
    // weak signal; 'read'/'deep' is genuine engagement. Surfaced so the model
    // doesn't read interest into something the customer barely skimmed.
    const depth = h.depth ? ` (${h.depth})` : ''
    return `[${ts}] ${channel}/${direction}${depth}${attribution}\n${h.chunk_text}`
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

// ── Population scope ─────────────────────────────────────────────────────────
// askPopulation is the cohort analog of ask: instead of one passport's recall,
// its evidence comes from population() — semantic match across ALL passports.
// It answers "what is going on across my customer base" questions. There is no
// structured context here (that registry is per-passport); the grounding is the
// cohort size plus representative content annotated with how many distinct
// customers each piece reached.

export const ASK_POPULATION_SYSTEM_PROMPT = [
  'You answer questions about a company\'s customer base as a whole — either the entire base or a cohort within it, never one person.',
  '',
  'You are given:',
  '  - Customer base: the total number of customers and a breakdown of content events by channel and direction. Use this for counting/aggregate questions.',
  '  - Cohort size: the number of DISTINCT customers whose content semantically matches the question. 0 means no customer has content specific to that concept.',
  '  - Evidence — one of:',
  '      • matching evidence (when a cohort matched the question), or',
  '      • a base-wide content sample, explicitly NOT filtered by the question (for broad/overview questions).',
  '    Each item is tagged with channel (mail/voip/web/crm), direction (exposure/expression/conversation/observation), and "seen by N" — how many distinct customers it reached.',
  '',
  'Rules:',
  '- Answer at the population level: aggregate, quantify, find patterns. "N customers…", "the most common…", "a recurring theme…".',
  '- For "how many customers…" questions, use the Customer base totals and breakdown — those are exact.',
  '- For targeted questions, lean on the cohort size + matching evidence. If the cohort size is 0, say plainly that no customers have content about that specific concept (do NOT infer relevance from an unfiltered base sample).',
  '- For broad/overview questions ("what are customers interested in", "what\'s going on"), summarize themes from the base-wide sample. Weight expressions (what customers said/wrote) over exposures (what we sent) as interest signal.',
  '- Ground magnitude in the numbers given. Do not fabricate precise figures; approximate honestly ("a sizable share", "a handful") when an exact count is not derivable.',
  '- A cohort is everyone whose content matches the question — not necessarily the whole base. Frame answers as "among customers who…" when that distinction matters.',
  '- If the base is empty or the evidence is too thin to support a claim, say so plainly.',
  '- Be concise. No preamble.',
].join('\n')

// Render base-wide aggregates into a compact, countable block for the LLM.
export function formatBaseStats(stats) {
  if (!stats || !stats.customers) return ''
  const lines = [`Customer base: ${stats.customers} customer${stats.customers === 1 ? '' : 's'}, ${stats.exposures} total content event${stats.exposures === 1 ? '' : 's'}.`]
  if (stats.breakdown?.length) {
    lines.push('By channel/direction:')
    for (const b of stats.breakdown) {
      lines.push(`  - ${b.channel}/${b.direction}: ${b.exposures} event${b.exposures === 1 ? '' : 's'} across ${b.customers} customer${b.customers === 1 ? '' : 's'}`)
    }
  }
  return lines.join('\n')
}

// Collapse population hits (one row per passport×chunk) into representative
// evidence: one entry per distinct chunk, carrying how many distinct customers
// it reached. Ranked by reach, then similarity — this is what conveys "volume"
// to the LLM without flooding the window with the same shared content repeated
// once per customer who saw it.
export function groupPopulationEvidence({ passports = [] } = {}, { sample = 60 } = {}) {
  const byChunk = new Map()
  for (const p of passports) {
    for (const h of p.hits || []) {
      const key = h.chunk_text || ''
      if (!key) continue
      let g = byChunk.get(key)
      if (!g) {
        g = { chunk_text: key, channel: h.channel, direction: h.direction, passports: new Set(), similarity: 0, ts: null }
        byChunk.set(key, g)
      }
      g.passports.add(p.passport_id)
      if ((h.similarity || 0) > g.similarity) g.similarity = h.similarity || 0
      const ts = h.ts instanceof Date ? h.ts : (h.ts ? new Date(h.ts) : null)
      if (ts && (!g.ts || ts > g.ts)) g.ts = ts
    }
  }
  return [...byChunk.values()]
    .map(g => ({
      chunk_text: g.chunk_text, channel: g.channel, direction: g.direction,
      similarity: g.similarity, ts: g.ts, passport_count: g.passports.size,
    }))
    .sort((a, b) => (b.passport_count - a.passport_count) || (b.similarity - a.similarity))
    .slice(0, sample)
}

export function formatPopulationEvidence(groups) {
  return groups.map(g => {
    const ts = g.ts instanceof Date ? g.ts.toISOString() : g.ts
    const when = ts ? `[${ts}] ` : ''
    const n = g.passport_count
    return `${when}${g.channel || '?'}/${g.direction || '?'} · seen by ${n} customer${n === 1 ? '' : 's'}\n${g.chunk_text}`
  }).join('\n---\n')
}

// askPopulation({ question, similarity?, limit?, sample?, instruction?, schema? })
//   similarity — cohort match threshold (default 0.6, looser than the raw
//                population() default so thematic questions have evidence to work with).
//   sample     — max distinct chunks fed to the LLM as evidence.
//   instruction / schema — same override / structured-output contract as ask().
//
// Always grounds on base-wide aggregates (customer totals + channel/direction
// breakdown). When the question maps to a semantic cohort, the evidence is that
// cohort's matching content. When it doesn't — a whole-base/overview question,
// or a counting question — it falls back to a query-independent base sample so
// the answer is still grounded instead of "nothing matched".
export async function askPopulation({ question, similarity = 0.6, limit = 1000, sample = 60, instruction, schema } = {}) {
  const [stats, cohort] = await Promise.all([
    populationStats ? populationStats() : Promise.resolve({ customers: 0, exposures: 0, breakdown: [] }),
    population({ query: question, similarity, limit }),
  ])

  // Truly empty base — nothing to say (a schema caller still wants a result).
  if ((stats?.customers || 0) === 0 && !schema) {
    return { answer: 'There are no customers in the base yet.', cohort: { count: 0 }, stats, evidence: [] }
  }

  let groups = groupPopulationEvidence(cohort, { sample })
  let overview = false

  // No semantic cohort → broad/overview/counting question. Ground on a
  // representative sample of the whole base instead of returning nothing.
  if (!groups.length && sampleContent) {
    overview = true
    const rows = await sampleContent({ limit: sample })
    groups = rows.map(r => ({
      chunk_text: r.chunk_text, channel: r.channel, direction: r.direction,
      ts: r.ts, similarity: null, passport_count: Number(r.customers) || 0,
    }))
  }

  const evidence = formatPopulationEvidence(groups)
  const statsBlock = formatBaseStats(stats)

  const sections = []
  if (statsBlock) sections.push(statsBlock)
  sections.push(`Cohort size: ${cohort.count} distinct customer${cohort.count === 1 ? '' : 's'} match this question.`)
  if (evidence) {
    sections.push(overview
      ? `Base-wide content sample (NOT filtered by the question — for overview/aggregate use only):\n${evidence}`
      : `Evidence (customers whose content matches the question):\n${evidence}`)
  }
  sections.push(`Question: ${question}`)

  const system = instruction || ASK_POPULATION_SYSTEM_PROMPT
  const user = sections.join('\n\n')

  if (schema) {
    const result = await ai.object(system, user, schema)
    return { ...result, cohort: { count: cohort.count }, stats, evidence: groups }
  }
  const answer = await ai.prompt(system, user)
  return { answer, cohort: { count: cohort.count }, stats, evidence: groups }
}
