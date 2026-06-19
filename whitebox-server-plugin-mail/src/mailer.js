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

export async function send({ attachments = [], ...msg }) {
  // Saved attachments are public URLs/filenames; resolve each to a local path
  // the provider can read and format for its own API (path for an SMTP-style
  // transport, base64 for a JSON API, etc.).
  const resolved = attachments.map(url => {
    const filename = path.basename(url)
    return { filename, path: path.join(attachmentsFolder, filename) }
  })
  return provider.send({ ...msg, attachments: resolved })
}
