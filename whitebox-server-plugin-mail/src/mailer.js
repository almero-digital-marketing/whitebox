import path from 'path'
import nodemailer from 'nodemailer'
import mg from 'nodemailer-mailgun-transport'

// Dependencies captured once via init() — module-level singleton, no
// wrapping factory closure. Matches the core pattern.
let domain
let attachmentsFolder
let transport

export function init(deps) {
  const { apiKey, domain: d } = deps.config.mail.mailgun
  domain = d
  attachmentsFolder = deps.config.mail.attachmentsFolder
  transport = nodemailer.createTransport(mg({ auth: { api_key: apiKey, domain } }))
}

export async function send({ from, to, replyTo, subject, html, text, headers, attachments = [], track = false }) {
  const resolved = attachments.map(url => ({
    path: path.join(attachmentsFolder, path.basename(url)),
  }))

  const info = await transport.sendMail({
    from: from || `noreply@${domain}`,
    to,
    replyTo,
    subject,
    html,
    text,
    headers,
    attachments: resolved,
    'o:tracking': track ? 'yes' : 'no',
  })
  return info
}
