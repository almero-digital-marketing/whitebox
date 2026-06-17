// Acme Cloud — a SaaS app integrating the whole WhiteBox client surface:
//   • core        — session/passport resolution, transport, consent
//   • engagement  — reading / image-dwell tracking on the marketing page
//   • crm         — client observations of in-app product usage
//
// Bundled by serve.mjs (esbuild) from the workspace packages. Add a new client
// plugin here when one ships — wire it into `plugins`, surface it in the UI, and
// log its events in one place below.

import whitebox from 'whitebox-client'
import engagementPlugin from 'whitebox-client-plugin-engagement'
import crmPlugin from 'whitebox-client-plugin-crm'

const logEl = document.querySelector('#log')
const statusEl = document.querySelector('#status')
const passportEl = document.querySelector('#passport')
const consentPill = document.querySelector('#consent-pill')

// Expandable log row: summary always visible, full payload on click.
function log(kind, summary, detail) {
  const row = document.createElement('div')
  row.className = `row ${kind}`
  const head = document.createElement('div')
  head.className = 'head'
  const has = detail !== undefined && detail !== null
  head.innerHTML = `<span class="t">${new Date().toLocaleTimeString()}</span> ` +
    `<span class="caret">${has ? '▸' : ' '}</span> <span class="k">${kind}</span> <span class="d"></span>`
  head.querySelector('.d').textContent = typeof summary === 'string' ? summary : JSON.stringify(summary)
  row.appendChild(head)
  if (has) {
    const pre = document.createElement('pre')
    pre.className = 'detail'
    pre.textContent = JSON.stringify(detail, null, 2)
    row.appendChild(pre)
    head.addEventListener('click', () => {
      const open = row.classList.toggle('open')
      head.querySelector('.caret').textContent = open ? '▾' : '▸'
    })
  }
  logEl.prepend(row)
}
function setStatus(text, ok) { statusEl.textContent = text; statusEl.className = ok ? 'ok' : '' }
const sel = (v) => (window.CSS && CSS.escape) ? CSS.escape(v) : String(v).replace(/"/g, '\\"')
function markRead(attr, id) { document.querySelector(`[${attr}="${sel(id)}"]`)?.setAttribute('data-wb-read', '1') }

// ── the whole client surface, in one constructor ──────────────────────────
const wb = whitebox({
  url: location.origin,
  consent: { required: ['analytics', 'marketing'] },
  logger: { debug: () => {}, warn: (...a) => log('warn', a.join(' ')), error: (...a) => log('error', a.join(' ')) },
  plugins: [
    // Reading / image tracking on the marketing copy (always on in this demo).
    engagementPlugin({
      flushIntervalMs: 2000, batchSize: 5,
      text: { cps: 20, minRequiredMs: 1500, rootMargin: '0% 0% -30% 0%', minRatio: 0.35, readingLineRatio: 0.25,
              scrollVelocityForFontSize: (px) => 0.05 * (px / 16) ** 10.32, scrollQuietMs: 100 },
    }),
    // In-app observations — gated on marketing consent (granted via the banner).
    crmPlugin({ consent: 'marketing', flushIntervalMs: 1500, batchSize: 3 }),
  ],
})
window.wb = wb

// ── core: transport + engagement events ───────────────────────────────────
wb.on('transport:connected',    () => { setStatus('live · socket connected', true); log('session', 'socket connected') })
wb.on('transport:disconnected', d  => { setStatus('session ready · socket down'); log('session', `socket down: ${d?.reason || ''}`) })
wb.on('engagement.text',  e => { log('text',  `read “${e.id}” (${e.length_chars}c, ${e.ms_spent}ms)`, e); markRead('data-wb-text', e.id) })
wb.on('engagement.image', e => { log('image', `viewed ${e.id} (${e.ms_spent}ms)`, e); markRead('data-wb-image', e.id) })
wb.on('engagement.video', e => log('video', `watched ${e.id} · ${e.completion_pct}%`, e))

// ── consent banner → core consent ─────────────────────────────────────────
const banner = document.querySelector('#consent')
function refreshConsent() {
  const a = wb.consent.has('analytics'), m = wb.consent.has('marketing')
  consentPill.textContent = `consent: ${a || m ? [a && 'analytics', m && 'marketing'].filter(Boolean).join('+') : 'none'}`
  consentPill.className = `pill ${m ? 'on' : 'off'}`
}
document.querySelector('#consent-accept').addEventListener('click', () => {
  wb.consent.grant('analytics'); wb.consent.grant('marketing')
  log('consent', 'granted analytics + marketing'); banner.classList.add('hide'); refreshConsent()
})
document.querySelector('#consent-reject').addEventListener('click', () => {
  wb.consent.revoke('analytics'); wb.consent.revoke('marketing')
  log('consent', 'rejected — product observations will be dropped'); banner.classList.add('hide'); refreshConsent()
})

// ── in-app dashboard → crm observations ───────────────────────────────────
document.querySelectorAll('[data-crm-kind]').forEach(btn => {
  btn.addEventListener('click', () => {
    const kind = btn.dataset.crmKind, body = btn.dataset.crmBody
    if (!wb.consent.has('marketing')) {
      log('warn', `crm "${kind}" dropped — grant marketing consent first`)
      return
    }
    wb.crm.observe({ kind, body })
    log('crm', `${kind} · ${body}`, { kind, body })
  })
})

// ── ready ──────────────────────────────────────────────────────────────────
try {
  await wb.ready
  window.__wbReady = true
  setStatus('session ready', true)
  passportEl.textContent = wb.passportId || '(none — is the server up?)'
  log('ready', `passport ${wb.passportId}`)
  refreshConsent()
} catch (err) {
  setStatus('error'); log('error', `init failed: ${err?.message || err}`); throw err
}

document.querySelector('#flush').addEventListener('click', () => {
  wb.engagement?.flush?.(); wb.crm?.flush?.(); log('session', 'forced flush (engagement + crm)')
})
document.querySelector('#copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(wb.passportId || ''); log('session', 'passport id copied')
})
