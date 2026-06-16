// WhiteBox engagement demo — wires the real client SDK to the page.
// Bundled by serve.mjs (esbuild) from the workspace packages. If you see a
// "Failed to resolve module specifier" error, you're not serving via
// `node serve.mjs` — open the URL it prints instead.

import whitebox from 'whitebox-client'
import engagementPlugin from 'whitebox-client-plugin-engagement'

const logEl = document.querySelector('#log')
const statusEl = document.querySelector('#status')
const passportEl = document.querySelector('#passport')

// log(kind, summary[, detail]) — if `detail` is given, the row is clickable and
// expands to the full pretty-printed payload so you can inspect every field.
function log(kind, summary, detail) {
  const row = document.createElement('div')
  row.className = `row ${kind}`
  const head = document.createElement('div')
  head.className = 'head'
  const hasDetail = detail !== undefined && detail !== null
  head.innerHTML = `<span class="t">${new Date().toLocaleTimeString()}</span> ` +
    `<span class="caret">${hasDetail ? '▸' : ' '}</span> ` +
    `<span class="k">${kind}</span> <span class="d"></span>`
  head.querySelector('.d').textContent = typeof summary === 'string' ? summary : JSON.stringify(summary)
  row.appendChild(head)
  if (hasDetail) {
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

// Reachability probe — independent of the SDK, time-bounded.
;(async () => {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 5000)
  try {
    const r = await fetch('/sessions/resolve', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: ctrl.signal,
    })
    log('probe', `/sessions/resolve → HTTP ${r.status}` + (r.status >= 500 ? ' (server not reachable through proxy)' : ''))
  } catch (e) {
    log('probe', `/sessions/resolve ${e.name === 'AbortError' ? 'timed out — server not responding' : 'failed: ' + e.message}`)
  } finally { clearTimeout(t) }
})()

const wb = whitebox({
  url: location.origin,
  logger: { debug: () => {}, warn: (...a) => log('warn', a.join(' ')), error: (...a) => log('error', a.join(' ')) },
  plugins: [
    engagementPlugin({
      flushIntervalMs: 2000,
      batchSize: 5,
      // Genuine-reading detection — a block only counts once it has actually
      // held your attention: sitting in the central reading band, with the
      // scroll-velocity gate closed (you stopped to read), accumulating dwell
      // proportional to its length. So nothing fires just because it loaded
      // on-screen — you have to scroll to it and pause.
      //
      // Close to the SDK defaults, with two nudges: cps (reading speed) raised
      // so demo paragraphs need a few seconds not ten, and the reading band
      // widened from the default -20% to -10% (counts in the central 80% of the
      // viewport rather than the central 60%).
      text: {
        cps: 45,                         // ~chars/sec; higher = shorter dwell to count as read
        minRequiredMs: 1500,             // floor: even a short line needs ~1.5s
        rootMargin: '-10% 0% -10% 0%',   // reading band = central 80% of viewport
      },
      // images: ~3s of viewport dwell (SDK default)
    }),
  ],
})
window.wb = wb

wb.on('transport:connected',    () => { setStatus('live · socket connected', true); log('socket', 'connected') })
wb.on('transport:disconnected', d  => { setStatus('session ready · socket down'); log('socket', `disconnected: ${d?.reason || ''}`) })
wb.on('engagement.text',  e => { log('text',  `“${e.id}” ${e.length_chars}c · ${e.ms_spent}ms${e.partial ? ' · partial' : ''}`, e); markRead('data-wb-text', e.id) })
wb.on('engagement.image', e => { log('image', `${e.id} · ${e.ms_spent}ms${e.partial ? ' · partial' : ''}`, e); markRead('data-wb-image', e.id) })
wb.on('engagement.video', e => log('video', `${e.id} · ${e.total_watched_s}s · ${e.completion_pct}%${e.partial ? ' · partial' : ''}`, e))

try {
  await wb.ready
  window.__wbReady = true
  setStatus('session ready', true)
  passportEl.textContent = wb.passportId || '(none — is the server up?)'
  log('ready', `passport ${wb.passportId}`)
  if (!wb.passportId) log('warn', 'No passport — /sessions/resolve returned none. Is whitebox-server up at WB_SERVER?')
} catch (err) {
  setStatus('error'); log('error', `init failed: ${err?.message || err}`); throw err
}

document.querySelector('#flush').addEventListener('click', () => { wb.engagement.flush(); log('flush', 'forced flush') })
document.querySelector('#copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(wb.passportId || ''); log('copy', 'passport id copied')
})
