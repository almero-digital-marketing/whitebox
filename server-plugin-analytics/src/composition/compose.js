// The AI compose loop — turn a plain-language question into widget specs over the
// core selector engine. The trick to getting VALID queries out of the model is to
// ground it in the data's real vocabulary: the actual fact keys (+ sample values)
// and content tags discovered from the DB. We use ctx.ai.prompt (text) + strict
// JSON parsing rather than generateObject, to avoid coupling to a zod version.

let db, ai, selector, awareness, logger
let schemaCache = null

export function init(deps) {
  ({ db, ai, selector, awareness, logger } = deps)
}

// Discover the queryable vocabulary so the model only references real keys/tags.
export async function discoverSchema({ refresh = false } = {}) {
  if (schemaCache && !refresh) return schemaCache
  const keyRows = await db('whitebox_facts').select('key').count('* as n').groupBy('key').orderBy('n', 'desc')
  const factKeys = []
  for (const { key } of keyRows.slice(0, 20)) {
    const vals = await db('whitebox_facts').where({ key }).distinct('value').limit(8)
    const sample = vals.map(v => v.value).filter(v => v != null && typeof v !== 'object').slice(0, 8)
    factKeys.push({ key, sample })
  }
  // Event dimensions reach their typed homes (docs/event-attributes.md): the action
  // is meta.event; campaign/source are session UTM columns; channel is on the event.
  // content_id is untrusted/opaque and is never surfaced as a queryable vocabulary.
  const events = (await db('whitebox_awareness_exposures').distinct(db.raw("meta->>'event' as event")).whereRaw("meta->>'event' is not null").limit(40)).map(r => r.event).filter(Boolean)
  const campaigns = (await db('whitebox_sessions').distinct('utm_campaign').whereNotNull('utm_campaign').limit(40)).map(r => r.utm_campaign)
  const sources = (await db('whitebox_sessions').distinct('utm_source').whereNotNull('utm_source').limit(40)).map(r => r.utm_source)
  const channels = (await db('whitebox_awareness_exposures').distinct('channel').whereNotNull('channel')).map(r => r.channel)
  // the meta.* keys (besides `event`) usable as filter/group dimensions — attr:<key>
  const attrRes = await db.raw('select distinct jsonb_object_keys(meta) as k from whitebox_awareness_exposures where meta is not null')
  const attrKeys = (attrRes.rows || []).map(r => r.k).filter(k => k && k !== 'event')
  schemaCache = { factKeys, events, attrKeys, campaigns, sources, channels }
  return schemaCache
}

function systemPrompt({ factKeys, events, attrKeys, campaigns, sources, channels }) {
  const keyList = factKeys.map(k => `  - ${k.key}${k.sample.length ? ` (e.g. ${k.sample.map(JSON.stringify).join(', ')})` : ''}`).join('\n')
  return `You compose analytics widgets for a beauty-clinic customer database (WhiteBox).
Turn the user's question into 1–4 widgets. Output ONLY a JSON array — no prose, no code fences.

YOUR JOB IS TO MODEL THE QUESTION AS A STRUCTURED QUERY. First DECOMPOSE it; model
as much as possible structurally — do NOT punt the sentence to a free-text answer:
- WHO    → a people filter (fact / metric / about). "active clients" → fact client_status eq active.
- WHEN    → an event window: "last month / last 30 days" → "last":"30d"; "this week" → "7d". (A window, not the trend grain.)
- SPLIT BY → a group dimension: a fact, "channel", session UTM, or any event attribute "attr:<key>".
            "what are they interested in" → split by attr:treatment. "by campaign" → session:utm_campaign.
- MEASURE → "count" (events), "sum":{"field":"value"} (revenue), or "distinct_passports" (distinct people).
Use "answer" ONLY when the ask is irreducibly qualitative — free-form themes/sentiment with NO structured
dimension (e.g. "what are people complaining about") — NEVER just to avoid decomposing.

Each widget: { "title", "kind": "stat"|"timeseries"|"breakdown"|"donut"|"radar"|"distribution"|"scatter"|"funnel"|"dropoff"|"table"|"answer", "query" }

Query shapes:
- stat  (a cohort count):       {"selector":{"filter":<filter>},"projection":"people"}
- table (the matching people):  {"selector":{"filter":<filter>},"projection":"people"}
- timeseries (a measure over time): {"selector":{"filter":{"metric":{"attrs":{"event":"<event>"},"count":{}}}},"projection":"knowledge","group":{"by":"week"}}
        (revenue: "sum":{"field":"value"}; grain "by" is day|week|month)
- breakdown (split a measure by a dimension): {"selector":{"filter":{"metric":{<event filters>,"distinct_passports":{}}}},"group":{"by":"<dim>"}}
        <dim>: "channel" | "session:utm_campaign" | "session:utm_source" | "attr:<key>";  OR split a FACT: {"breakdownFact":{"key":"<factKey>","values":[...]}}
- donut (SAME query as breakdown — use when the ask is "share of / proportion / mix / split of total"): identical shape to breakdown.
- radar (SAME query as breakdown — use for a "profile / shape / across dimensions" comparison, e.g. engagement across channels): identical shape to breakdown. Best with 3+ buckets on a comparable scale (counts/people).
- distribution (a histogram — "how is X distributed / spread", "by how many"): {"distribution":{"source":"fact"|"event","key":"<factKey or event>"}}
        source "fact" = bin a NUMERIC fact's value per person (lifetime_value, visits_count). source "event" = bin how many of an event each person did.
        Optional "bins":[edges] for fixed buckets, else auto. Optional "scope" cohort.
- scatter (a RELATIONSHIP between TWO numbers — "X vs Y", "correlation", "do high-X clients also Y"): {"scatter":{"x":"<numericFactKey>","y":"<numericFactKey>","colorBy":"<factKey>"}}
        One dot per person at (x, y), both numeric facts. Optional "colorBy" tints dots by a categorical fact. Optional "scope" cohort.
- COMPARE (overlay several series — "A vs B", "compare", "versus", "by segment"): on a stat/timeseries/breakdown/radar query, add EITHER:
    "splitBy":{"key":"<factKey>","values":[...]} — split the SAME measure into one series per fact value (active vs lapsed, gold vs silver), OR
    "series":[{"name":"...","query":<full query>}, ...] — compare genuinely different queries (opened-email cohort vs got-a-call cohort).
    Prefer splitBy when the comparison is one fact's values; use series when the measure or cohort differs per series.
- funnel: {"funnel":{"steps":[{"name":"Sent","select":{"filter":{"metric":{"attrs":{"event":"email_sent"},"count":{"gte":1}}}}}, ...]}}
- dropoff (the "negative funnel" — same {"funnel":{"steps":[...]}} shape as funnel): renders the people LOST between each step instead of the survivors. Use when the ask is about abandonment / who fell out / who to re-engage / win-back — the drop-off cohorts are the audiences.
- answer (LAST RESORT, qualitative only): {"question":"<the question>", "scope":<people sub-filter>, "last":"30d"}
        Even an answer must be scoped: pass the cohort ("scope") and window ("last") from the question —
        never read the whole base, all time. Use answer only for free-form "why/what themes", not counts.

Confine an aggregate (breakdown/timeseries) OR an answer to a COHORT with "scope" — a people sub-filter,
resolved for you — and to a window with "last":
  {"selector":{...},"group":{"by":"<dim>"},"scope":{"filter":{"fact":{"client_status":{"eq":"active"}}}}}

<filter> grammar (boolean tree of clauses):
- fact:   {"fact":{"<key>":{"<op>":<value>}}}   ops: eq, ne, in, gt, gte, lt, lte, present
- metric (event aggregate): {"metric":{ <event filters>, "count":{"gte":1}, "last":"30d"}}
    event filters: "attrs":{"event":"<event>"} (or {"event":{"in":[...]}}, or {"<attrKey>":{"present":true}}); "session":{"utm_campaign":"<c>"}; "channel":"<ch>"
- combine: {"all":[...]}, {"any":[...]}, {"not":...}
- semantic: add "about":"<topic words>" at the selector top level

NEVER use content_id (untrusted/opaque). Slice events only by attrs.*, session UTM, or channel.

HARD RULES for measures (count / sum / distinct_passports):
- A measure is a "timeseries" or "breakdown"/"donut"/"radar" with "group" — NEVER a "stat". "stat" is ONLY a
  people/cohort COUNT: {"selector":{"filter":<people filter>},"projection":"people"}. Revenue/bookings-over-time = timeseries.
- A "stat" ALWAYS uses "projection":"people" — NEVER "knowledge". Counting PEOPLE who did an event (reached /
  delivered / opened / clicked / booked) is a stat: {"selector":{"filter":{"metric":{<event filters>,"count":{"gte":1}}}},"projection":"people"}.
- A grouped / timeseries query's "selector.filter" must be EXACTLY ONE "metric" — never an "all"/"any"/"fact" beside it.
- To limit a measure to a COHORT (an audience, "active clients", "lapsed VIPs"), put that cohort in the query's
  top-level "scope" (a people sub-filter) — NEVER fold it into the metric's filter. A campaign metric is already
  scoped by "session":{"utm_campaign":"<c>"}; only add "scope" for an ADDITIONAL audience constraint.

FACT keys:
${keyList}
Event actions (attr:event): ${events.join(', ')}
Other event attributes (attr:<key>): ${attrKeys.join(', ')}
Campaigns (session:utm_campaign): ${campaigns.join(', ')}
Sources (session:utm_source): ${sources.join(', ')}
Channels: ${channels.join(', ')}

Prefer 1–3 widgets. Keep titles short. Use only the keys/events/values above.

Examples:
Q: "How many active clients?" → [{"title":"Active clients","kind":"stat","query":{"selector":{"filter":{"fact":{"client_status":{"eq":"active"}}}},"projection":"people"}}]
Q: "How many did the flash_sale_sms campaign reach, and how many clicked?" → [{"title":"Reached","kind":"stat","query":{"selector":{"filter":{"metric":{"session":{"utm_campaign":"flash_sale_sms"},"count":{"gte":1}}}},"projection":"people"}},{"title":"Clicked","kind":"stat","query":{"selector":{"filter":{"metric":{"attrs":{"event":"sms_click"},"session":{"utm_campaign":"flash_sale_sms"},"count":{"gte":1}}}},"projection":"people"}}]
Q: "What are our active customers most interested in last month?" → [{"title":"Active customers' interest (last 30d)","kind":"breakdown","query":{"selector":{"filter":{"metric":{"attrs":{"treatment":{"present":true}},"last":"30d","count":{}}}},"group":{"by":"attr:treatment"},"scope":{"filter":{"fact":{"client_status":{"eq":"active"}}}}}}]
Q: "Email opens per week" → [{"title":"Email opens per week","kind":"timeseries","query":{"selector":{"filter":{"metric":{"attrs":{"event":"email_open"},"count":{}}}},"projection":"knowledge","group":{"by":"week"}}}]
Q: "Clients by campaign" → [{"title":"Clients by campaign","kind":"breakdown","query":{"selector":{"filter":{"metric":{"distinct_passports":{}}}},"group":{"by":"session:utm_campaign"}}}]
Q: "Share of clients by acquisition source" → [{"title":"Client mix by source","kind":"donut","query":{"selector":{"filter":{"metric":{"distinct_passports":{}}}},"group":{"by":"session:utm_source"}}}]
Q: "Engagement profile across channels" → [{"title":"Reach by channel","kind":"radar","query":{"selector":{"filter":{"metric":{"distinct_passports":{}}}},"group":{"by":"channel"}}}]
Q: "How is lifetime value distributed?" → [{"title":"Lifetime value distribution","kind":"distribution","query":{"distribution":{"source":"fact","key":"lifetime_value"}}}]
Q: "Distribution of bookings per customer" → [{"title":"Bookings per customer","kind":"distribution","query":{"distribution":{"source":"event","key":"booking"}}}]
Q: "Lifetime value vs visit count" → [{"title":"Value vs visits","kind":"scatter","query":{"scatter":{"x":"visits_count","y":"lifetime_value","colorBy":"client_status"}}}]
Q: "Treatment mix: active vs lapsed" → [{"title":"Treatment mix: active vs lapsed","kind":"breakdown","query":{"selector":{"filter":{"metric":{"attrs":{"treatment":{"present":true}},"distinct_passports":{}}}},"group":{"by":"attr:treatment"},"splitBy":{"key":"client_status","values":["active","lapsed"]}}}]
Q: "Compare active and lapsed client counts" → [{"title":"Active vs lapsed","kind":"stat","query":{"series":[{"name":"Active","query":{"selector":{"filter":{"fact":{"client_status":{"eq":"active"}}}},"projection":"people"}},{"name":"Lapsed","query":{"selector":{"filter":{"fact":{"client_status":{"eq":"lapsed"}}}},"projection":"people"}}]}}]
Q: "Revenue per month" → [{"title":"Revenue per month","kind":"timeseries","query":{"selector":{"filter":{"metric":{"attrs":{"event":"booking"},"sum":{"field":"value"}}}},"projection":"knowledge","group":{"by":"month"}}}]
Q: "What are lapsed clients unhappy about lately?" → [{"title":"Why lapsed clients are unhappy (last 60d)","kind":"answer","query":{"question":"What are lapsed clients unhappy about?","scope":{"filter":{"fact":{"client_status":{"eq":"lapsed"}}}},"last":"60d"}}]`
}

function parseWidgets(text) {
  let t = (text || '').trim()
  if (t.startsWith('```')) t = t.replace(/^```[a-z]*\n?/i, '').replace(/```\s*$/, '').trim()
  let arr
  try { arr = JSON.parse(t) }
  catch {
    const m = t.match(/\[[\s\S]*\]/)            // salvage the first JSON array
    if (!m) throw new Error('AI did not return a JSON array')
    arr = JSON.parse(m[0])
  }
  if (!Array.isArray(arr)) arr = [arr]
  const KINDS = new Set(['stat', 'timeseries', 'breakdown', 'donut', 'radar', 'distribution', 'scatter', 'pivot', 'heatmap', 'cohort', 'table', 'answer', 'funnel', 'dropoff'])
  return arr
    .filter(w => w && KINDS.has(w.kind) && w.query && typeof w.query === 'object' && usableQuery(w.kind, w.query))
    .slice(0, 4)
    .map(w => ({ title: String(w.title || w.kind), kind: w.kind, query: w.query }))
}

// Reject the malformed shapes that runQuery throws on, BEFORE they're persisted — a
// model can emit a distribution with no key or a funnel with no steps, and a stored
// broken widget would then error on every resolve forever. Drop it at compose time.
function usableQuery(kind, q) {
  if (kind === 'distribution') return !!q.distribution?.key
  if (kind === 'scatter') return !!(q.scatter?.x && q.scatter?.y)
  if (kind === 'funnel' || kind === 'dropoff') return Array.isArray(q.funnel?.steps) && q.funnel.steps.length > 0
  if (kind === 'answer') return typeof q.question === 'string' && q.question.trim().length > 0
  return true   // selector/series-shaped kinds: the engine handles/empties gracefully
}

// The inverse of compose: a query def → one plain-language question (so switching
// Query → Agent shows the built query as editable free text).
export async function describeQuery(query) {
  if (!ai?.prompt) throw new Error('AI provider not configured')
  const sys = `Translate this analytics query (JSON) back into ONE short, plain-language question a marketer would ask about their customers — the inverse of composing a query. Output only the sentence, no JSON, no preamble.
The query selects/aggregates clinic customers:
- filter.fact gates on an attribute (e.g. client_status eq active)
- filter.metric counts/sums events; attrs.event = the action (email_open, booking…); session.utm_campaign/source = acquisition; last = a window
- about = a semantic topic
- group.by buckets over a time grain (week/month) or a dimension (channel, session:utm_campaign, attr:event)
- breakdownFact splits a cohort by a fact's values
- distribution = a histogram: source fact bins a numeric fact's value per person, source event bins how many of an event each person did
- scatter = one dot per person at (x, y), two numeric facts; colorBy tints by a categorical fact
- splitBy = compare the same measure across one fact's values (e.g. active vs lapsed) — phrase it as a comparison
- series = compare several named sub-queries against each other — phrase it as a comparison of those series
- question = a grounded natural-language answer
- projection people = a cohort; knowledge = evidence`
  const text = await ai.prompt(sys, JSON.stringify(query))
  return (text || '').trim()
}

// Read a widget's RESULT and explain it in 1–2 plain sentences (the left-column insight).
// `data` is already compacted to the essentials (see routes.compactForExplain).
export async function explainWidget({ title, kind, data }) {
  if (!ai?.prompt) throw new Error('AI provider not configured')
  const sys = `You are a beauty-clinic analytics co-pilot. In 1–2 short, plain sentences, turn this widget's result into the OPPORTUNITY it points to for the clinic owner — the cohort worth targeting or winning back, the leak to plug, the upsell, the channel or treatment to double down on. Lead with that opportunity, then anchor it in ONE concrete number: the top/bottom item, the trend direction, a share, the biggest funnel drop-off, (for a drop-off / negative funnel) the step with the biggest leak and how many people fell out there — that lost cohort is a re-engagement audience, (for a comparison of named series) which series leads and by how much, or (when a target is given) progress toward it (count vs target, pctOfTarget).
Be concrete with the numbers and only claim what the data supports — never invent a recommendation the result can't back. Start DIRECTLY with the finding/opportunity. Never open with "The widget shows", "The headline", "This shows", "The result", or by restating the title. No markdown, no bullet points, no preamble. If the result is empty, say so plainly.`
  const text = await ai.prompt(sys, JSON.stringify({ title, kind, data }))
  return (text || '').trim()
}

// Profile ONE client (a row selected from a list widget) → a 1–2 sentence insight
// about THEM. `facts`/`activity` are gathered by the caller (routes); we only prompt.
export async function explainPerson({ who, facts = {}, activity = [], context } = {}) {
  if (!ai?.prompt) throw new Error('AI provider not configured')
  const sys = `You are a beauty-clinic analytics co-pilot. In 1–2 short, plain sentences, profile THIS ONE client for the clinic owner — who they are and the most decision-useful specifics (lifecycle status, lifetime value, visit count, last/next treatment, recent engagement). Be concrete with their actual numbers and dates; only state what the data shows.${context ? ` They appear in the list "${context}".` : ''}
Start DIRECTLY with the finding. No "This client"/"The client" preamble, no markdown, no bullet points.`
  const text = await ai.prompt(sys, JSON.stringify({ who, facts, recentActivity: activity }))
  return (text || '').trim()
}

// question → [{ title, kind, query }] (validated specs, not yet persisted).
export async function composeWidgets(question) {
  if (!ai?.prompt) throw new Error('AI provider not configured')
  const schema = await discoverSchema()
  const text = await ai.prompt(systemPrompt(schema), question)
  const widgets = parseWidgets(text)
  if (!widgets.length) throw new Error('AI returned no usable widgets')
  logger?.info?.({ question, n: widgets.length }, 'composed widgets')
  return widgets
}

// ── suggested questions (the compose box "Try one:" chips) ──────────────────────
// A freshly-created report is named "Untitled report", so the NAME is only a clue
// once the user (or a compose) has given it a real one. The clue hierarchy is:
//   existing widgets  →  meaningful name  →  just the data vocabulary
// so the chips are always grounded in something real and degrade gracefully.
const UNTITLED = /^\s*untitled/i
const isMeaningfulName = (n) => !!n && !UNTITLED.test(n) && n.trim().length > 1

function suggestPrompt(schema, { name, widgets }) {
  const { factKeys, events, attrKeys, campaigns, sources, channels } = schema
  const vocab = [
    `Facts: ${factKeys.map((k) => k.key).join(', ')}`,
    `Events: ${events.join(', ')}`,
    attrKeys.length ? `Event attributes: ${attrKeys.join(', ')}` : '',
    campaigns.length ? `Campaigns: ${campaigns.join(', ')}` : '',
    sources.length ? `Sources: ${sources.join(', ')}` : '',
    channels.length ? `Channels: ${channels.join(', ')}` : '',
  ].filter(Boolean).join('\n')

  const has = Array.isArray(widgets) && widgets.length
  let context, task
  if (has) {
    context = `The report "${name}" already has these widgets:\n${widgets.map((w) => `- ${w.title} (${w.kind})`).join('\n')}`
    task = 'Suggest FOLLOW-UP questions that deepen or complement what is already there — a different cut, a cohort split, a trend, a related metric. Do NOT repeat an existing widget.'
  } else if (isMeaningfulName(name)) {
    context = `The report is titled "${name}" but has no widgets yet.`
    task = 'Suggest starter questions that fit that title — the widgets a clinic owner opening this report would want first.'
  } else {
    context = 'A brand-new, empty, untitled report.'
    task = 'Suggest broad but useful starter questions that showcase the data — mix a count, a trend, a breakdown, a funnel, a distribution.'
  }

  return `You suggest analytics questions for a beauty-clinic customer database (WhiteBox).
${context}

${task}

Rules:
- Output ONLY a JSON array of 4–6 short strings. No prose, no keys, no code fences.
- Each is a plain question a marketer would type, ≤ 9 words, no trailing punctuation.
- Reference ONLY the real vocabulary below, and vary the shape (count / trend / breakdown / funnel / distribution / who-list).
- Keep them concrete and clickable, e.g. "Revenue per month", "Lapsed clients by preferred treatment".

Available data vocabulary:
${vocab}`
}

function parseSuggestions(text) {
  let t = (text || '').trim()
  if (t.startsWith('```')) t = t.replace(/^```[a-z]*\n?/i, '').replace(/```\s*$/, '').trim()
  let arr
  try { arr = JSON.parse(t) }
  catch {
    const m = t.match(/\[[\s\S]*\]/)
    if (!m) return []
    try { arr = JSON.parse(m[0]) } catch { return [] }
  }
  if (!Array.isArray(arr)) return []
  return arr
    .map((s) => String(s).trim().replace(/^[-*\d.\s]+/, '').replace(/[?.]+$/, ''))   // strip list bullets / trailing punctuation
    .filter((s) => s && s.length <= 80)
    .slice(0, 6)
}

// { name?, widgets?: [{title, kind}] } → ["short question", …] (4–6). Grounded in the
// discovered vocabulary; throws if the model returns nothing usable (caller falls back).
export async function suggestQuestions({ name = '', widgets = [] } = {}) {
  if (!ai?.prompt) throw new Error('AI provider not configured')
  const schema = await discoverSchema()
  const text = await ai.prompt(suggestPrompt(schema, { name, widgets }), 'Suggest the questions now.')
  const out = parseSuggestions(text)
  if (!out.length) throw new Error('no suggestions produced')
  return out
}
