#!/usr/bin/env node
// Probe whether ARI is reachable on the configured PBX, using the same
// credentials whitebox already has. No plugin code is touched; this is a
// pure read-only introspection script.
//
// Usage:
//   node scripts/probe-ari.js
//     reads whitebox.config.js from the sibling whitebox-pro-server checkout
//
//   ARI_URL=http://pbx:8088 ARI_USER=foo ARI_PASS=bar node scripts/probe-ari.js
//     overrides via env vars (useful for trying alternate creds without
//     touching the production config)
//
// Reports six checks in order; each one tells you whether to keep going.

import fs from 'fs'
import path from 'path'
import http from 'http'
import https from 'https'
import { URL } from 'url'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const C = { ok: '\x1b[32m✓\x1b[0m', no: '\x1b[31m✗\x1b[0m', q: '\x1b[33m?\x1b[0m', dim: '\x1b[2m', reset: '\x1b[0m' }
const line = (...a) => console.log(...a)
const dim  = (s) => `${C.dim}${s}${C.reset}`

async function loadConfig() {
  // 1. Env-var overrides — useful when you want to probe alternate ARI creds.
  if (process.env.ARI_URL && process.env.ARI_USER && process.env.ARI_PASS) {
    return {
      candidates: [process.env.ARI_URL],
      ariUser:    process.env.ARI_USER,
      ariPass:    process.env.ARI_PASS,
      source:     'env',
    }
  }

  // 2. whitebox-pro-server's config in the sibling repo.
  const cfgPath = path.resolve(__dirname, '../../whitebox-pro-server/whitebox.config.js')
  if (!fs.existsSync(cfgPath)) {
    throw new Error(`Couldn't find whitebox.config.js at ${cfgPath}. Set ARI_URL / ARI_USER / ARI_PASS to override.`)
  }
  const mod = await import(cfgPath)
  // The config default is an `async (runtime) => ({...})` factory; resolve it.
  // A plain object is still accepted for back-compat.
  const exported = mod.default ?? mod
  const cfg = typeof exported === 'function' ? await exported({}) : exported
  // Plugins are built objects in cfg.plugins now (voip({...}) → { name, options, ... }),
  // so the voip block lives on the voip plugin's `options`, not at cfg.voip.
  const voip = cfg.plugins?.find(p => p?.name === 'voip')?.options || cfg.voip || {}

  // ARI is almost always on a different port than the recordings HTTP server.
  // Default Asterisk mod_http port is 8088. We try a few candidate URLs in
  // order and report the first one that responds with an ARI signal.
  const monitorOrigin = voip.monitor?.url ? new URL(voip.monitor.url).origin : null
  const monitorHost   = voip.monitor?.url ? new URL(voip.monitor.url).hostname : null
  const pbxHost       = voip.pbx?.host

  const candidates = []
  const add = (u) => { if (u && !candidates.includes(u)) candidates.push(u) }

  // Most likely first: PBX host on 8088 (Asterisk default mod_http port).
  if (pbxHost)     add(`http://${pbxHost}:8088`)
  if (monitorHost) add(`http://${monitorHost}:8088`)
  // Same hostname on 8089 (TLS-enabled mod_http).
  if (pbxHost)     add(`https://${pbxHost}:8089`)
  if (monitorHost) add(`https://${monitorHost}:8089`)
  // Last resort: the monitor URL's origin (sometimes ARI is proxied behind
  // the same host as the recordings — uncommon but worth trying).
  add(monitorOrigin)

  return {
    candidates,
    ariUser: voip.monitor?.auth?.username ?? voip.pbx?.user,
    ariPass: voip.monitor?.auth?.password ?? voip.pbx?.password,
    source:  'config',
    notes: [
      `voip.monitor.url     = ${voip.monitor?.url ?? '(unset)'}`,
      `voip.pbx.host        = ${pbxHost ?? '(unset)'}`,
      `Will try in order    = ${candidates.join(' → ')}`,
      `Using user/pass      = monitor.auth → pbx (fallback)`,
    ],
  }
}

// Probe one candidate URL — returns 'yes' / 'no' / 'maybe' along with details.
// 'yes'   = /ari discovery endpoint exists (200 or 401)
// 'maybe' = HTTP responds but ARI not found (404 / 302 etc.) — module not loaded OR wrong port
// 'no'    = host unreachable / connection refused / timeout
async function probeAriEndpoint(baseUrl) {
  const discoUrl = baseUrl.replace(/\/$/, '') + '/ari/api-docs/resources.json'
  try {
    const r = await httpGet(discoUrl)
    if (r.status === 200 || r.status === 401) return { result: 'yes',   status: r.status, url: baseUrl }
    return                                          { result: 'maybe', status: r.status, url: baseUrl }
  } catch (err) {
    return                                          { result: 'no',    error: err.message, url: baseUrl }
  }
}

// Simple GET with basic auth, no external deps. Returns { status, headers, body }.
function httpGet(rawUrl, { user, pass } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(rawUrl)
    const lib = u.protocol === 'https:' ? https : http
    const headers = {}
    if (user && pass) headers.authorization = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
    const req = lib.request({
      method: 'GET',
      host: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers,
      timeout: 5000,
    }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }))
    })
    req.on('timeout', () => { req.destroy(new Error('timeout')); })
    req.on('error', reject)
    req.end()
  })
}

async function main() {
  const cfg = await loadConfig()

  line('')
  line(`Configuration source: ${cfg.source}`)
  if (cfg.notes) for (const n of cfg.notes) line(dim('  ' + n))
  line(`Credentials:    ${cfg.ariUser ?? '(none)'}:${cfg.ariPass ? '***' : '(none)'}`)
  line('')

  if (!cfg.candidates?.length) {
    line(`${C.no} No URLs to probe.`)
    process.exit(1)
  }

  // ── Check 1+2 combined: find an ARI endpoint among the candidates ──────
  line(`${C.q} 1/5  Locating ARI among candidate URLs …`)
  const probes = await Promise.all(cfg.candidates.map(probeAriEndpoint))
  for (const p of probes) {
    const label = p.result === 'yes'   ? `${C.ok} ARI`
                : p.result === 'maybe' ? `${C.q } HTTP-only (no /ari)`
                : `${C.no} unreachable`
    const detail = p.status ? `HTTP ${p.status}` : p.error
    line(dim(`     ${label.padEnd(28)} ${p.url}  (${detail})`))
  }
  const winner = probes.find(p => p.result === 'yes')
  if (!winner) {
    const httpOnly = probes.find(p => p.result === 'maybe')
    if (httpOnly) {
      line(`${C.no} 1/5  No ARI endpoint found on any candidate URL.`)
      line(dim('     HTTP responds but /ari is missing — res_ari isn\'t loaded, or it\'s on a non-default port.'))
      line(dim('     Override with: ARI_URL=http://your-pbx:PORT ARI_USER=foo ARI_PASS=bar node scripts/probe-ari.js'))
    } else {
      line(`${C.no} 1/5  No host responded on any candidate URL.`)
      line(dim('     The PBX host may be unreachable from where you\'re running this.'))
    }
    process.exit(2)
  }
  line(`${C.ok} 1/5  Found ARI at ${winner.url}  (HTTP ${winner.status})`)
  const baseUrl = winner.url

  // (Steps 1+2 from before collapse here — we already confirmed the module is loaded.)
  line(`${C.ok} 2/5  ARI module is loaded`)
  const cfgWithUrl = { ...cfg, ariUrl: baseUrl }

  // ── Check 3: Credentials accepted ──────────────────────────────────────
  line(`${C.q} 3/5  Credentials accepted (GET /ari/asterisk/info) …`)
  const infoUrl = cfgWithUrl.ariUrl.replace(/\/$/, '') + '/ari/asterisk/info'
  const info = await httpGet(infoUrl, { user: cfg.ariUser, pass: cfg.ariPass })
    .catch(e => ({ status: 0, _err: e.message }))
  if (info.status === 200) {
    let parsed = null
    try { parsed = JSON.parse(info.body.toString('utf8')) } catch {}
    line(`${C.ok} 3/5  Credentials work`)
    if (parsed) {
      line(dim(`     Asterisk version: ${parsed.version || parsed.system?.version || '(unknown)'}`))
      line(dim(`     Entity ID:        ${parsed.config?.entity_id || parsed.system?.entity_id || '(unknown)'}`))
    }
  } else if (info.status === 401) {
    line(`${C.no} 3/5  Credentials REJECTED (HTTP 401)`)
    line(dim('     The ARI user/pass in ari.conf differs from what we tried.'))
    line(dim('     Set ARI_USER / ARI_PASS env vars and re-run.'))
    process.exit(4)
  } else {
    line(`${C.no} 3/5  Unexpected: HTTP ${info.status}${info._err ? ' — ' + info._err : ''}`)
    process.exit(4)
  }

  // ── Check 4: List stored recordings ────────────────────────────────────
  line(`${C.q} 4/5  Recordings list (GET /ari/recordings/stored) …`)
  const recsUrl = cfgWithUrl.ariUrl.replace(/\/$/, '') + '/ari/recordings/stored'
  const recs = await httpGet(recsUrl, { user: cfg.ariUser, pass: cfg.ariPass })
    .catch(e => ({ status: 0, _err: e.message }))
  let recList = []
  if (recs.status === 200) {
    try { recList = JSON.parse(recs.body.toString('utf8')) } catch {}
    line(`${C.ok} 4/5  Recordings endpoint works — ${recList.length} stored recording(s)`)
    if (recList.length) {
      for (const r of recList.slice(0, 3)) {
        line(dim(`     • ${r.name} (${r.format})`))
      }
      if (recList.length > 3) line(dim(`     … and ${recList.length - 3} more`))
    } else {
      line(dim('     (none stored — try again after a real call has been recorded)'))
    }
  } else {
    line(`${C.no} 4/5  Recordings endpoint failed: HTTP ${recs.status}${recs._err ? ' — ' + recs._err : ''}`)
    process.exit(5)
  }

  // ── Check 5: Fetch one binary ──────────────────────────────────────────
  // This is the critical one — does ARI actually deliver the audio bytes?
  // If recList is empty we can only confirm the endpoint exists; we can't
  // verify a real download. In that case mark as "partial".
  if (!recList.length) {
    line(`${C.q} 5/5  Binary download — SKIPPED (no recordings to fetch)`)
    line('')
    line(`${C.ok} ARI is reachable, authenticated, and the recordings endpoint works.`)
    line(`   Make a test call (which produces a recording) and re-run to confirm download.`)
    process.exit(0)
  }
  const sample = recList[0]
  const fileUrl = cfgWithUrl.ariUrl.replace(/\/$/, '') + `/ari/recordings/stored/${encodeURIComponent(sample.name)}/file`
  line(`${C.q} 5/5  Binary download (GET ${dim('…/' + sample.name + '/file')}) …`)
  const file = await httpGet(fileUrl, { user: cfg.ariUser, pass: cfg.ariPass })
    .catch(e => ({ status: 0, _err: e.message }))
  if (file.status === 200) {
    const ct = file.headers['content-type'] || '(none)'
    line(`${C.ok} 5/5  Got ${file.body.length} bytes (Content-Type: ${ct})`)
    line('')
    line(`${C.ok} All checks passed — ARI is a viable replacement for the HTTP-scrape path.`)
    line('')
    line('   Next step (optional): install `ari-client` and use ari.recordings.getStoredFile()')
    line('   in voip/src/recorder.js instead of the current Cheerio-scrape approach.')
    process.exit(0)
  } else {
    line(`${C.no} 5/5  Binary download failed: HTTP ${file.status}${file._err ? ' — ' + file._err : ''}`)
    process.exit(6)
  }
}

main().catch(err => {
  console.error(`\x1b[31mFatal:\x1b[0m`, err.message)
  process.exit(99)
})
