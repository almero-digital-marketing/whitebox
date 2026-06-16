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

// --- Per-element timer badges ---------------------------------------------
// Live dwell visualised next to each tracked element. Rendered as absolutely
// positioned overlays on <body> (NOT children of the tracked element — that
// would pollute its textContent, which the tracker reads as the captured text).
const BADGE_W = 124
const badges = new Map()   // `${kind}:${id}` -> { el, target }
function targetEl(kind, id) {
  const attr = kind === 'image' ? 'data-wb-image' : 'data-wb-text'
  return document.querySelector(`[${attr}="${sel(id)}"]`)
}
function ensureBadge(kind, id) {
  const key = `${kind}:${id}`
  let entry = badges.get(key)
  if (entry) return entry
  const target = targetEl(kind, id)
  if (!target) return null
  const el = document.createElement('div')
  el.className = 'wb-timer'
  el.innerHTML = '<span class="wb-timer-txt"></span><span class="wb-timer-bar"><i></i></span>'
  document.body.appendChild(el)
  entry = { el, target }
  badges.set(key, entry)
  return entry
}
function placeBadge(entry) {
  const r = entry.target.getBoundingClientRect()
  // Document coords → the absolutely-positioned badge scrolls with the page.
  entry.el.style.top = `${window.scrollY + r.top + 2}px`
  entry.el.style.left = (r.left >= BADGE_W + 16)
    ? `${window.scrollX + r.left - BADGE_W - 12}px`   // margin note in the left gutter
    : `${window.scrollX + r.left + 6}px`              // no gutter → tuck inside top-left
}
function showProgress(p) {
  const entry = ensureBadge(p.kind, p.id)
  if (!entry || entry.el.classList.contains('done')) return
  entry.el.querySelector('.wb-timer-txt').textContent =
    `${(p.ms_spent / 1000).toFixed(1)} / ${(p.required_ms / 1000).toFixed(1)}s`
  entry.el.querySelector('.wb-timer-bar > i').style.width = `${Math.round(p.ratio * 100)}%`
  entry.el.classList.toggle('reading', !!p.reading)
  placeBadge(entry)
}
function finishBadge(kind, id, partial) {
  const entry = ensureBadge(kind, id)
  if (!entry) return
  entry.el.classList.remove('reading')
  entry.el.classList.add(partial ? 'partial' : 'done')
  entry.el.querySelector('.wb-timer-bar > i').style.width = '100%'
  entry.el.querySelector('.wb-timer-txt').textContent = partial ? 'partial ✓' : 'read ✓'
  placeBadge(entry)
}
let placeScheduled = false
addEventListener('resize', () => {
  if (placeScheduled) return
  placeScheduled = true
  requestAnimationFrame(() => { placeScheduled = false; for (const e of badges.values()) placeBadge(e) })
})

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
      // Dwell required to count a read scales with text length: chars / cps.
      // cps 25 ≈ 240 wpm (average adult reading), so a ~200-char paragraph needs
      // ~8s and a ~350-char one ~14s — lower cps = more time per character.
      // Reading band widened from the default -20% to -10% (central 80% of the
      // viewport rather than 60%).
      text: {
        sequential: true,                // read top-to-bottom: only the topmost visible block
                                         // accumulates; headings + paragraphs are separate queues
        cps: 30,                         // ~chars/sec reading speed; lower = longer dwell to count as read
        minRequiredMs: 1500,             // floor: even a short line needs ~1.5s
        capRequiredMs: 60_000,           // ceiling: length scales dwell up to 60s, then caps
        // Max scroll velocity scales (non-linearly) with font size: a power law
        // fit through 16px → 0.05 px/ms and 30.4px → 0.5 px/ms, so the title
        // tolerates ~10× faster scrolling than body text.
        scrollVelocityForFontSize: (px) => 0.05 * (px / 16) ** 3.59,
        scrollQuietMs: 100,              // resume the timer 100ms after scrolling settles (default 250)
        // Reading band: top 0%, bottom 30%. Top 0% means a block counts from the
        // very top of the viewport (above-the-fold content included) and stays
        // counted until it scrolls off the top. The 30% bottom margin keeps an
        // entity entering from below the fold from grabbing focus until it has
        // scrolled up into the top 70% of the viewport (genuinely readable).
        rootMargin: '0% 0% -30% 0%',
        minRatio: 0.35,                  // forgiving — focus holds a block until it's mostly off-band
        // A block you've read and scrolled up releases focus once its middle passes
        // above the top 25% of the viewport, so a block sitting at the very top
        // stops blocking blocks still on screen below it.
        readingLineRatio: 0.25,
      },
      // images: ~3s of viewport dwell (SDK default)
    }),
  ],
})
window.wb = wb

wb.on('transport:connected',    () => { setStatus('live · socket connected', true); log('socket', 'connected') })
wb.on('transport:disconnected', d  => { setStatus('session ready · socket down'); log('socket', `disconnected: ${d?.reason || ''}`) })
wb.on('engagement.progress', showProgress)
wb.on('engagement.text',  e => { log('text',  `“${e.id}” ${e.length_chars}c · ${e.ms_spent}ms${e.partial ? ' · partial' : ''}`, e); markRead('data-wb-text', e.id); finishBadge('text', e.id, e.partial) })
wb.on('engagement.image', e => { log('image', `${e.id} · ${e.ms_spent}ms${e.partial ? ' · partial' : ''}`, e); markRead('data-wb-image', e.id); finishBadge('image', e.id, e.partial) })
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
