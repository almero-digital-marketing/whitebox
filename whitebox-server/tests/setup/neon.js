import fs from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

// .env.test is expected one directory up from whitebox-server's checkout, so
// sibling polyrepo plugins (linked via `npm link whitebox-server`) all read
// the same secrets without duplicating them across repos. Parsed inline to
// avoid pulling dotenv into every plugin's transitive deps.
function loadEnvFile(envPath) {
  try {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
    }
  } catch {
    // Allow tests to supply env vars from the calling shell instead.
  }
}
const here = path.dirname(fileURLToPath(import.meta.url))
loadEnvFile(path.resolve(here, '../../../.env.test'))

const NEON_API = 'https://console.neon.tech/api/v2'

let projectId
let branchId

async function neon(method, path, body) {
  const res = await fetch(`${NEON_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.NEON_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Neon API ${method} ${path} failed (${res.status}): ${text}`)
  }

  return res.json()
}

export async function setup() {
  projectId = process.env.NEON_PROJECT_ID
  if (!projectId) throw new Error('NEON_PROJECT_ID is required')
  if (!process.env.NEON_API_KEY) throw new Error('NEON_API_KEY is required')

  const branchName = `test-${Date.now()}`

  console.log(`\nCreating Neon branch: ${branchName}`)

  const data = await neon('POST', `/projects/${projectId}/branches`, {
    branch: { name: branchName },
    endpoints: [{ type: 'read_write' }],
  })

  branchId = data.branch.id
  process.env.DATABASE_URL = data.connection_uris[0].connection_uri

  console.log(`Neon branch ready: ${branchId}\n`)
}

export async function teardown() {
  if (!branchId) return
  console.log(`\nDeleting Neon branch: ${branchId}`)
  await neon('DELETE', `/projects/${projectId}/branches/${branchId}`)
  console.log('Neon branch deleted\n')
}
