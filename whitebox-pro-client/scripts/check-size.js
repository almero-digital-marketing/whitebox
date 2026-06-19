// CI gate: fail if any bundle entry exceeds its budget.
//
// Run after `npm run build`.

import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { gzipSize } from 'gzip-size'

const BUDGETS_GZ = {
  'dist/index.js':       8 * 1024,
  'dist/mail.js':        3 * 1024,
  'dist/engagement.js':  8 * 1024,
  'dist/conversions.js': 3 * 1024,
  'dist/consent.js':     2 * 1024,
  'dist/voip.js':        4 * 1024,
}

async function measure(file) {
  if (!existsSync(file)) return null
  const buf = await readFile(file)
  const gz = await gzipSize(buf)
  return { raw: buf.byteLength, gz }
}

function fmt(bytes) {
  return `${(bytes / 1024).toFixed(2)} KB`
}

let failed = false
console.log('\nBundle size check\n─────────────────')

for (const [file, budget] of Object.entries(BUDGETS_GZ)) {
  const m = await measure(file)
  if (!m) {
    console.log(`  ${file.padEnd(28)}  (missing)`)
    failed = true
    continue
  }
  const status = m.gz <= budget ? '✓' : '✗'
  const line = `  ${status} ${path.basename(file).padEnd(20)}  ${fmt(m.gz).padStart(8)} gz / ${fmt(budget)} budget  (raw ${fmt(m.raw)})`
  console.log(line)
  if (m.gz > budget) failed = true
}

console.log()
if (failed) {
  console.error('Bundle size check FAILED\n')
  process.exit(1)
} else {
  console.log('All bundles within budget ✓\n')
}
