import path from 'path'
import crypto from 'crypto'
import { writeFile } from 'fs/promises'

// Dependencies captured once via init() — module-level singleton, no
// wrapping factory closure. Matches the core pattern.
let folder
let baseUrl

export function init(deps) {
  folder = deps.folder
  baseUrl = deps.baseUrl
}

export async function saveBuffer(buffer, originalFilename) {
  const ext = path.extname(originalFilename) || ''
  const filename = `${crypto.randomUUID()}${ext}`
  await writeFile(path.join(folder, filename), buffer)
  return `${baseUrl}/${filename}`
}

export async function saveUrl(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch attachment: ${url} (${res.status})`)
  const buffer = Buffer.from(await res.arrayBuffer())
  const originalFilename = path.basename(new URL(url).pathname) || 'attachment'
  return saveBuffer(buffer, originalFilename)
}

export function localPath(attachmentUrl) {
  return path.join(folder, path.basename(attachmentUrl))
}
