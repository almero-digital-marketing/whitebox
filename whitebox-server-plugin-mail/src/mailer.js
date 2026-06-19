import path from 'path'

// Provider-agnostic send. The composed provider (whitebox-mail-mailgun,
// whitebox-mail-postmark, …) owns the SDK/transport; this module only resolves
// stored attachments to local paths and delegates. Captured once via init().
let provider
let attachmentsFolder

export function init(deps) {
  provider = deps.provider
  attachmentsFolder = deps.attachmentsFolder
}

// Saved attachments are public URLs/filenames; resolve each to a local path the
// provider can read and format for its own API (path for an SMTP-style
// transport, base64 for a JSON API, etc.).
function resolve(attachments = []) {
  return attachments.map(url => {
    const filename = path.basename(url)
    return { filename, path: path.join(attachmentsFolder, filename) }
  })
}

export async function send({ attachments = [], ...msg }) {
  return provider.send({ ...msg, attachments: resolve(attachments) })
}

// Does the composed provider implement native batch send?
export const supportsBatch = () => typeof provider?.sendBatch === 'function'
export const maxBatchSize = () => provider?.maxBatchSize || 1

// Send many messages in one provider call. Returns a result per message,
// aligned with input order: { messageId, error }.
export async function sendBatch(messages) {
  const resolved = messages.map(({ attachments = [], ...m }) => ({ ...m, attachments: resolve(attachments) }))
  return provider.sendBatch(resolved)
}
