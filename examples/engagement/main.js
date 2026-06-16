// WhiteBox engagement demo — wires the real client SDK to the page.
// Bundled by serve.mjs (esbuild) from the workspace packages. If you see a
// "Failed to resolve module specifier" error, you're not serving via
// `node serve.mjs` — open http://localhost:5173 from that server instead.

import whitebox from 'whitebox-client'
import engagementPlugin from 'whitebox-client-plugin-engagement'

const logEl = document.querySelector('#log')
const statusEl = document.querySelector('#status')
const passportEl = document.querySelector('#passport')

function log(kind, data) {
  const row = document.createElement('div')
  row.className = `row ${kind}`
  row.innerHTML = `<span class="t">${new Date().toLocaleTimeString()}</span> ` +
    `<span class="k">${kind}</span> <span class="d"></span>`
  row.querySelector('.d').textContent = typeof data === 'string' ? data : JSON.stringify(data)
  logEl.prepend(row)
}
function setStatus(text, ok) { statusEl.textContent = text; statusEl.className = ok ? 'ok' : '' }

// Served same-origin via serve.mjs, which proxies /sessions, /socket.io,
// /engagement, … to the real whitebox-server. So the SDK url is just us.
const wb = whitebox({
  url: location.origin,
  logger: {
    debug: () => {},
    warn:  (...a) => log('warn', a.join(' ')),
    error: (...a) => log('error', a.join(' ')),
  },
  plugins: [
    // Short flush interval + small batch so events show up quickly in the demo.
    engagementPlugin({ flushIntervalMs: 2000, batchSize: 5 }),
  ],
})
window.wb = wb

// Register listeners BEFORE awaiting ready — the socket connects during init.
wb.on('transport:connected',    () => { setStatus('live · socket connected', true); log('socket', 'connected') })
wb.on('transport:disconnected', d  => { setStatus('session ready · socket down'); log('socket', `disconnected: ${d?.reason || ''}`) })
wb.on('engagement.text',  e => log('text',  `“${e.id}” ${e.length_chars}c · ${e.ms_spent}ms${e.partial ? ' · partial' : ''}`))
wb.on('engagement.image', e => log('image', `${e.id} · ${e.ms_spent}ms${e.partial ? ' · partial' : ''}`))
wb.on('engagement.video', e => log('video', `${e.id} · ${e.total_watched_s}s · ${e.completion_pct}%${e.partial ? ' · partial' : ''}`))

try {
  await wb.ready
  window.__wbReady = true
  setStatus('session ready', true)
  passportEl.textContent = wb.passportId || '(none — is the server up?)'
  log('ready', `passport ${wb.passportId}`)
  if (!wb.passportId) {
    log('warn', 'No passport — /sessions/resolve did not return one. Is whitebox-server running at WB_SERVER and reachable through the proxy?')
  }
} catch (err) {
  setStatus('error')
  log('error', `init failed: ${err?.message || err}`)
  throw err
}

document.querySelector('#flush').addEventListener('click', () => { wb.engagement.flush(); log('flush', 'forced flush') })
document.querySelector('#copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(wb.passportId || ''); log('copy', 'passport id copied')
})
