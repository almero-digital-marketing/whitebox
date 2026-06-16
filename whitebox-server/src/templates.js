import path from 'path'
import crypto from 'crypto'
import { writeFile } from 'fs/promises'

const EXT_BY_MIME = {
  'text/html': 'html',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/css': 'css',
  'application/pdf': 'pdf',
  'application/json': 'json',
  'application/xml': 'xml',
  'application/xhtml+xml': 'xhtml',
  'application/rss+xml': 'rss',
  'application/atom+xml': 'atom',
  'application/javascript': 'js',
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
}

function extFromContentType(contentType) {
  // Strip charset and other params: "text/html; charset=utf-8" → "text/html"
  const mime = contentType.split(';')[0].trim()
  return EXT_BY_MIME[mime] || 'bin'
}

// Dependencies + config captured once via init() — module-level singleton, no
// wrapping factory closure. Matches the core pattern (passports, sessions, …).
let url
let base
let token
let outputFolder
let headers
const outputUrl = '/output'

export function init({ config }) {
  ;({ url, base = '/mikser', token, outputFolder } = config.mikser)
  headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

async function request(entity) {
  const res = await fetch(`${url}${base}/render`, {
    method: 'POST',
    headers,
    body: JSON.stringify(entity),
  })

  if (res.status === 204) return null

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Mikser render failed (${res.status}): ${text}`)
  }

  const contentType = res.headers.get('content-type') || 'application/octet-stream'
  const buffer = Buffer.from(await res.arrayBuffer())

  return { contentType, buffer }
}

export async function renderText(entity) {
  const result = await request(entity)
  if (!result) return null
  return result.buffer.toString('utf8')
}

export async function renderFile(entity) {
  const result = await request(entity)
  if (!result) return null

  const ext = extFromContentType(result.contentType)
  const filename = `${crypto.randomUUID()}.${ext}`
  await writeFile(path.join(outputFolder, filename), result.buffer)

  return `${outputUrl}/${filename}`
}
