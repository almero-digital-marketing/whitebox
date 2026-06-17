// WhiteBox console — ask grounded questions about a passport and inspect its
// memory, with NO external Claude/OpenAI client: every call hits the server's
// own /analytics/* routes (the server does the LLM synthesis). Plain fetch, no
// SDK. serve.mjs proxies /analytics + hands us the analytics token from .env.

const $ = (s) => document.querySelector(s)
const passportEl = $('#passport')
const tokenEl = $('#token')
const qEl = $('#q')
const outEl = $('#out')
const srvHint = $('#srvhint')

// These map to the content the integration demo (Brightsmile Dental) actually
// produces: service reads (whitening, Invisalign, implants, pricing/insurance),
// CRM observations (registration, appointment, treatment plans, payment plans,
// emergencies), sales-call transcripts, and callback requests.
const PREDEFINED = [
  'What do we know about this patient, and what have they done?',
  'Did they read about pricing, insurance, or payment plans?',
  'Have they accepted or viewed a treatment plan?',
  'Have they booked an appointment or registered as a new patient?',
  'Did they call the clinic or request a callback? What about?',
  'Which treatments are they interested in (whitening, implants, Invisalign)?',
]

// Population scope — questions about the whole patient base, no passport needed.
const POPULATION_QUESTIONS = [
  'What treatments are patients most interested in?',
  'How many patients have asked about teeth whitening?',
  'What do patients ask about when they call the clinic?',
  'How many patients booked an appointment or registered?',
  'What are patients asking about insurance and payment plans?',
  'How many patients requested an emergency appointment?',
]

// One-click example concepts for the raw retrieval tools (prefill + run) —
// concepts that exist verbatim in the integration demo's content.
const RECALL_EXAMPLES = ['teeth whitening', 'dental implants', 'Invisalign', 'payment plans', 'emergency appointment', 'insurance']
const COHORT_EXAMPLES = ['teeth whitening', 'dental implants', 'Invisalign clear aligners', 'checkup and cleaning', 'payment plans', 'emergency appointment']

// ── persistence ────────────────────────────────────────────────────────────
passportEl.value = localStorage.getItem('wb.console.passport') || ''
tokenEl.value = localStorage.getItem('wb.console.token') || ''
passportEl.addEventListener('change', () => localStorage.setItem('wb.console.passport', passportEl.value.trim()))
tokenEl.addEventListener('change', () => localStorage.setItem('wb.console.token', tokenEl.value.trim()))

// Pull the analytics token from the server's .env so the console is turnkey.
;(async () => {
  try {
    const { analyticsToken } = await fetch('/console/config').then(r => r.json())
    if (analyticsToken && !tokenEl.value) { tokenEl.value = analyticsToken; localStorage.setItem('wb.console.token', analyticsToken) }
    srvHint.textContent = analyticsToken ? 'token loaded from .env' : 'paste your analytics token →'
  } catch { srvHint.textContent = 'paste your analytics token →' }
})()

// ── rendering ────────────────────────────────────────────────────────────────
function card({ kind, title, answer, stat, evidence, context, json, error }) {
  const div = document.createElement('div')
  const cls = error ? 'err' : (kind === 'ask' ? '' : (kind === 'all' ? 'all' : 'tool'))
  const head = document.createElement('div')
  head.className = `qline ${cls}`
  head.innerHTML = `<span class="badge">${kind}</span>`
  head.appendChild(document.createTextNode(title))
  div.appendChild(head)

  if (stat) { const s = document.createElement('div'); s.className = 'stat'; s.textContent = stat; div.appendChild(s) }
  if (answer != null) { const a = document.createElement('div'); a.className = 'answer'; a.textContent = answer; div.appendChild(a) }
  if (Array.isArray(evidence) && evidence.length) {
    const d = document.createElement('details')
    d.innerHTML = `<summary>evidence (${evidence.length})</summary>`
    for (const h of evidence) {
      const e = document.createElement('div'); e.className = 'ev'
      const ts = h.ts ? new Date(h.ts).toISOString().slice(0, 16).replace('T', ' ') : '?'
      // population evidence carries a customer reach count; per-passport recall doesn't.
      const seen = h.passport_count != null ? ` · ${h.passport_count} customer${h.passport_count === 1 ? '' : 's'}` : ''
      e.innerHTML = `<div class="meta">[${ts}] ${h.channel || '?'}/${h.direction || '?'}${seen}</div>`
      e.appendChild(document.createTextNode(h.chunk_text || ''))
      d.appendChild(e)
    }
    div.appendChild(d)
  }
  if (context && Object.keys(context).length) {
    const d = document.createElement('details'); d.innerHTML = '<summary>structured context</summary>'
    const pre = document.createElement('pre'); pre.textContent = JSON.stringify(context, null, 2); d.appendChild(pre); div.appendChild(d)
  }
  if (json !== undefined) { const pre = document.createElement('pre'); pre.textContent = JSON.stringify(json, null, 2); div.appendChild(pre) }
  outEl.prepend(div)
  return div
}

// ── server calls ─────────────────────────────────────────────────────────────
function needToken() {
  const token = tokenEl.value.trim()
  if (!token) { card({ kind: 'error', title: 'Set the analytics token first.', error: true }); return null }
  return token
}
function need() {
  const passport_id = passportEl.value.trim()
  if (!passport_id) { card({ kind: 'error', title: 'Set a passport id first (paste one from the integration demo header).', error: true }); return null }
  const token = needToken(); if (!token) return null
  return { passport_id, token }
}
async function authed(path, { method = 'GET', body } = {}, token) {
  const res = await fetch(path, {
    method,
    headers: { 'authorization': `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let data; try { data = JSON.parse(text) } catch { data = text }
  if (!res.ok) throw new Error(typeof data === 'string' ? data : (data?.error ? JSON.stringify(data.error) : `HTTP ${res.status}`))
  return data
}

async function ask(question) {
  const ctx = need(); if (!ctx) return
  const pending = card({ kind: 'ask', title: question }); pending.querySelector('.qline').insertAdjacentHTML('beforeend', ' <span class="spin">…thinking</span>')
  try {
    const r = await authed('/analytics/ask', { method: 'POST', body: { passport_id: ctx.passport_id, question } }, ctx.token)
    pending.remove()
    card({ kind: 'ask', title: question, answer: r.answer, evidence: r.evidence, context: r.context })
  } catch (e) { pending.remove(); card({ kind: 'error', title: `${question} — ${e.message}`, error: true }) }
}

// Population scope — a grounded answer over the whole customer base. No passport.
async function askPopulation(question) {
  const token = needToken(); if (!token) return
  const pending = card({ kind: 'all', title: question }); pending.querySelector('.qline').insertAdjacentHTML('beforeend', ' <span class="spin">…thinking</span>')
  try {
    const r = await authed('/analytics/ask-population', { method: 'POST', body: { question } }, token)
    pending.remove()
    const n = r.cohort?.count ?? 0
    const base = r.stats?.customers
    const stat = base != null
      ? `base: ${base} customer${base === 1 ? '' : 's'} · cohort match: ${n}${n === 0 ? ' (answered from base overview)' : ''}`
      : `cohort: ${n} customer${n === 1 ? '' : 's'} matched`
    card({ kind: 'all', title: question, answer: r.answer, evidence: r.evidence, stat })
  } catch (e) { pending.remove(); card({ kind: 'error', title: `${question} — ${e.message}`, error: true }) }
}

// Per-passport inspect tools — need a passport id.
async function tool(name) {
  const ctx = need(); if (!ctx) return
  try {
    let json, title = name
    if (name === 'timeline') json = await authed(`/analytics/timeline/${encodeURIComponent(ctx.passport_id)}`, {}, ctx.token)
    else if (name === 'context') json = await authed(`/analytics/context/${encodeURIComponent(ctx.passport_id)}`, {}, ctx.token)
    else if (name === 'recall') { const query = $('#recallq').value.trim() || 'pricing'; title = `recall: "${query}"`
      json = await authed('/analytics/recall', { method: 'POST', body: { passport_id: ctx.passport_id, query } }, ctx.token) }
    card({ kind: name, title, json })
  } catch (e) { card({ kind: 'error', title: `${name} — ${e.message}`, error: true }) }
}

// Raw cohort size — base-wide, token-only (no passport). "How many customers
// have content matching this concept?" The counting companion to Ask all.
// We pass an explicit similarity looser than the API default (0.75) — a short
// concept query rarely clears 0.75 against full-sentence chunks, so the default
// would report 0 even when the cohort is plainly there. 0.6 matches the
// All-customers ask, which grounds its cohort at the same threshold.
const COHORT_SIMILARITY = 0.6
async function cohort(concept) {
  const token = needToken(); if (!token) return
  const query = (concept || $('#cohortq').value.trim() || 'teeth whitening')
  try {
    const json = await authed('/analytics/population', { method: 'POST', body: { query, similarity: COHORT_SIMILARITY } }, token)
    const n = json.count ?? 0
    card({ kind: 'cohort', title: `cohort: "${query}"`, stat: `${n} customer${n === 1 ? '' : 's'} match`, json })
  } catch (e) { card({ kind: 'error', title: `cohort — ${e.message}`, error: true }) }
}

// ── tabs ───────────────────────────────────────────────────────────────────
const tabs = document.querySelectorAll('.tab')
const panels = { all: $('#tab-all'), one: $('#tab-one') }
tabs.forEach(t => t.addEventListener('click', () => {
  tabs.forEach(x => x.classList.toggle('active', x === t))
  for (const [key, el] of Object.entries(panels)) el.classList.toggle('active', key === t.dataset.tab)
}))

// ── wire up ──────────────────────────────────────────────────────────────────
const chips = $('#chips')
for (const q of PREDEFINED) {
  const b = document.createElement('button'); b.className = 'chip'; b.textContent = q
  b.addEventListener('click', () => { qEl.value = q; ask(q) })
  chips.appendChild(b)
}
$('#ask').addEventListener('click', () => { const q = qEl.value.trim(); if (q) ask(q) })
qEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const q = qEl.value.trim(); if (q) ask(q) } })
// 'population' is base-wide → cohort() (token-only); everything else is per-passport.
document.querySelectorAll('[data-tool]').forEach(b => b.addEventListener('click', () => {
  const t = b.dataset.tool
  if (t === 'population') cohort(); else tool(t)
}))

// Example concept chips for recall (per-customer) and cohort (base-wide).
function wireExamples(hostId, list, run) {
  const host = $(hostId)
  for (const c of list) {
    const b = document.createElement('button'); b.className = 'exchip'; b.textContent = c
    b.addEventListener('click', () => run(c))
    host.appendChild(b)
  }
}
wireExamples('#recallex', RECALL_EXAMPLES, (c) => { $('#recallq').value = c; tool('recall') })
wireExamples('#cohortex', COHORT_EXAMPLES, (c) => { $('#cohortq').value = c; cohort(c) })

// Population scope
const popchips = $('#popchips')
const popqEl = $('#popaskq')
for (const q of POPULATION_QUESTIONS) {
  const b = document.createElement('button'); b.className = 'chip'; b.textContent = q
  b.addEventListener('click', () => { popqEl.value = q; askPopulation(q) })
  popchips.appendChild(b)
}
$('#askpop').addEventListener('click', () => { const q = popqEl.value.trim(); if (q) askPopulation(q) })
popqEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const q = popqEl.value.trim(); if (q) askPopulation(q) } })
