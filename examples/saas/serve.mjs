#!/usr/bin/env node
// Dev server for the WhiteBox engagement demo.
//
//   • starts the whitebox-server as a child process (unless one is already
//     running on the target port, or WB_SERVER points at a remote host, or
//     WB_START_SERVER=0)
//   • serves the static demo page (index.html)
//   • bundles main.js — the real whitebox-client + engagement plugin — with
//     esbuild on the fly (no CDN, works offline)
//   • reverse-proxies API + WebSocket traffic to the server so the browser
//     talks to it SAME-ORIGIN (the server has no HTTP CORS)
//
//   Run:  node serve.mjs            # starts everything, opens on :5173
//         WB_SERVER=http://host:port node serve.mjs   # proxy to a remote server (no spawn)
//         WB_START_SERVER=0 node serve.mjs            # don't spawn; use an existing server

import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { build } from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 5173)
const TARGET = new URL(process.env.WB_SERVER || 'http://localhost:3000')
const TARGET_PORT = Number(TARGET.port || (TARGET.protocol === 'https:' ? 443 : 80))
const SERVER_DIR = path.resolve(__dirname, '../../whitebox-server')
const TARGET_IS_LOCAL = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(TARGET.hostname)
const START_SERVER = process.env.WB_START_SERVER !== '0' && TARGET_IS_LOCAL

const API_PREFIXES = [
  '/sessions', '/engagement', '/socket.io', '/analytics',
  '/mail', '/voip', '/crm', '/conversions', '/health', '/output',
]
const isApi = (url) => API_PREFIXES.some(p => url === p || url.startsWith(p + '/') || url.startsWith(p + '?'))

// ── whitebox-server child process ─────────────────────────────────────────
let child = null

function portOpen(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const s = net.connect({ port, host })
    s.setTimeout(600)
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('timeout', () => { s.destroy(); resolve(false) })
    s.once('error', () => resolve(false))
  })
}

function startServer() {
  console.log(`[demo] starting whitebox-server (${SERVER_DIR}) …`)
  child = spawn('node', ['--env-file-if-exists=.env', 'src/server.js'], {
    cwd: SERVER_DIR,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const pipe = (stream) => {
    let buf = ''
    stream.on('data', d => {
      buf += d.toString()
      const lines = buf.split('\n'); buf = lines.pop()
      for (const l of lines) if (l.trim()) console.log(`\x1b[2m[server]\x1b[0m ${l}`)
    })
  }
  pipe(child.stdout); pipe(child.stderr)
  child.on('exit', (code) => { console.log(`[demo] whitebox-server exited (code ${code})`); child = null })
}

function shutdown() {
  if (child) { child.kill('SIGTERM'); child = null }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('exit', () => { if (child) child.kill('SIGTERM') })

// ── bundling + proxy ──────────────────────────────────────────────────────
async function bundleMain() {
  const res = await build({
    entryPoints: [path.join(__dirname, 'main.js')],
    bundle: true, format: 'esm', write: false, sourcemap: 'inline', logLevel: 'warning',
  })
  return res.outputFiles[0].text
}

function proxyHttp(req, res) {
  const upstream = http.request({
    protocol: TARGET.protocol, hostname: TARGET.hostname, port: TARGET_PORT,
    method: req.method, path: req.url, headers: { ...req.headers, host: TARGET.host },
  }, up => { res.writeHead(up.statusCode, up.headers); up.pipe(res) })
  upstream.setTimeout(6000, () => upstream.destroy(new Error('upstream timeout (no response in 6s)')))
  upstream.on('error', err => {
    if (res.headersSent) return res.end()
    res.writeHead(504, { 'content-type': 'text/plain' })
    res.end(`proxy: ${err.message} — is whitebox-server up at ${TARGET.href}?`)
  })
  req.on('error', () => upstream.destroy())
  req.pipe(upstream)
}

const server = http.createServer(async (req, res) => {
  try {
    if (isApi(req.url)) return proxyHttp(req, res)
    const noCache = { 'cache-control': 'no-store, no-cache, must-revalidate' }
    const url = req.url.split('?')[0]
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...noCache })
      return res.end(await readFile(path.join(__dirname, 'index.html')))
    }
    if (url === '/main.js') {
      const js = await bundleMain()
      console.log(`[demo] bundled main.js (${(js.length / 1024).toFixed(0)} kB)`)
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', ...noCache })
      return res.end(js)
    }
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found')
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' }); res.end(String(err?.stack || err))
  }
})

// WebSocket upgrade (socket.io) — pipe raw bytes to the target.
server.on('upgrade', (req, clientSocket, head) => {
  const upstream = net.connect(TARGET_PORT, TARGET.hostname, () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`
    for (const [k, v] of Object.entries({ ...req.headers, host: TARGET.host })) raw += `${k}: ${v}\r\n`
    raw += '\r\n'
    upstream.write(raw)
    if (head && head.length) upstream.write(head)
    upstream.pipe(clientSocket); clientSocket.pipe(upstream)
  })
  upstream.on('error', () => clientSocket.destroy())
  clientSocket.on('error', () => upstream.destroy())
})

server.listen(PORT, async () => {
  console.log(`WhiteBox SaaS integration demo [auto-start server] → http://localhost:${PORT}`)
  console.log(`proxying API + WS → ${TARGET.href}`)

  if (!START_SERVER) {
    console.log(TARGET_IS_LOCAL
      ? '[demo] WB_START_SERVER=0 — not starting a server; expecting one already running'
      : '[demo] WB_SERVER is remote — not starting a local server')
    return
  }
  if (await portOpen(TARGET_PORT)) {
    console.log(`[demo] whitebox-server already running on :${TARGET_PORT} — reusing it`)
    return
  }
  startServer()
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 1000))
    if (await portOpen(TARGET_PORT)) { console.log(`[demo] whitebox-server ready on :${TARGET_PORT} — open http://localhost:${PORT}`); break }
    if (!child) { console.log('[demo] whitebox-server failed to start — see [server] logs above'); break }
  }
})
