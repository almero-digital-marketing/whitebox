#!/usr/bin/env node
// Reset the demo's awareness data so you can reseed a clean base.
//
// DESTRUCTIVE: TRUNCATEs whitebox_awareness_exposures + whitebox_awareness_chunks
// — that removes ALL awareness content (every passport's reads / observations /
// calls) on whatever DB whitebox-server/.env points at. Demo/dev DB only.
//
//   node examples/integration/reset.mjs            # wipe only
//   node examples/integration/reset.mjs --seed     # wipe, then reseed
//   COUNT=60 node examples/integration/reset.mjs --seed
//
// It reads the server's DB config from whitebox-server/.env directly, so you
// don't need --env-file or a DATABASE_URL. With --seed it runs seed.mjs after
// wiping (the server must be up for that step — same as running seed alone).

import knex from 'knex'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const wantSeed = process.argv.includes('--seed')
const env = { ...process.env }
try {
  const raw = fs.readFileSync(path.resolve(__dirname, '../../whitebox-server/.env'), 'utf8')
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?/)
    if (m && env[m[1]] === undefined) env[m[1]] = m[2]
  }
} catch { /* fall back to whatever is already in the environment */ }

if (!env.WB_DB_HOST) {
  console.error('No DB config (WB_DB_* in whitebox-server/.env). Fill it in, or export the vars first.')
  process.exit(1)
}

const db = knex({
  client: 'pg',
  connection: {
    host: env.WB_DB_HOST,
    port: Number(env.WB_DB_PORT || 5432),
    database: env.WB_DB_NAME,
    user: env.WB_DB_USER,
    password: env.WB_DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
  },
})

let cleared = false
try {
  const before = await db('whitebox_awareness_exposures').count({ n: '*' }).first()
  await db.raw('TRUNCATE whitebox_awareness_exposures, whitebox_awareness_chunks RESTART IDENTITY')
  console.log(`Cleared awareness data on ${env.WB_DB_NAME}@${env.WB_DB_HOST} (${before.n} exposures → 0).`)
  cleared = true
} catch (err) {
  console.error(`Reset failed: ${err.message}`)
  process.exitCode = 1
} finally {
  await db.destroy()
}

if (cleared && wantSeed) {
  console.log('\nReseeding…\n')
  const child = spawn(process.execPath, [path.join(__dirname, 'seed.mjs')], { stdio: 'inherit', env: process.env })
  child.on('exit', (code) => process.exit(code ?? 0))
} else if (cleared) {
  console.log('Now reseed:  node examples/integration/seed.mjs   (or re-run with --seed)')
}
