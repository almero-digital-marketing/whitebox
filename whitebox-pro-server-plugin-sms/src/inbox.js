import * as suppressions from './suppressions.js'
import { toE164 } from './phone.js'

const TABLE = 'whitebox_sms_inbox'

// Opt-out / opt-in keywords (carriers honor STOP network-side; we mirror it).
const STOP_WORDS  = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'optout', 'revoke'])
const START_WORDS = new Set(['start', 'yes', 'unstop', 'optin'])

function detectKeyword(body) {
  const w = String(body || '').trim().toLowerCase()
  if (STOP_WORDS.has(w)) return 'stop'
  if (START_WORDS.has(w)) return 'start'
  return null
}

let config, db, passports, sessions, awareness, notify, logger, router

export function init(deps) {
  ;({ config, db, passports, sessions, awareness, notify, logger, router } = deps)
}

const defaultCountry = () => config.sms?.defaultCountry

// POST /sms/webhooks/:provider/inbound — an inbound reply (MO). The provider in
// the path authenticates + parses; we link the sender's phone to a passport,
// honor STOP/START, store the message, and record it in awareness.
export async function handle(req, res) {
  const provider = router.byName(req.params.provider)
  if (!provider) return res.status(404).end()
  if (!provider.verifySignature?.(req, 'inbound')) return res.status(401).end()
  if (typeof provider.parseInbound !== 'function') return res.status(501).end()

  const parsed = provider.parseInbound(req) || {}
  const from = toE164(parsed.from, defaultCountry())
  if (!from) return res.status(200).end()

  const keyword = detectKeyword(parsed.body)
  if (keyword === 'stop') {
    await suppressions.add({ phone: from, reason: 'unsubscribed', source: 'inbound' }).catch(err => logger.error({ err }, 'Failed to suppress on STOP: %s', from))
  } else if (keyword === 'start') {
    await suppressions.remove(from).catch(err => logger.error({ err }, 'Failed to un-suppress on START: %s', from))
  }

  let passportId = null
  try {
    passportId = await passports.identify(null)
    await passports.link(passportId, [{ type: 'phone', name: 'e164', value: from }])
  } catch (err) {
    logger.warn({ err }, 'Failed to identify/link inbound sms sender: %s', from)
  }

  const session = passportId ? await sessions.resolve(passportId).catch(() => null) : null

  const [row] = await db(TABLE).insert({
    passport_id: passportId,
    session_id: session?.id || null,
    from,
    to: parsed.to || null,
    body: parsed.body || null,
    media: parsed.media?.length ? parsed.media : null,
    provider: provider.name,
    provider_message_id: parsed.messageId || null,
    keyword,
  }).returning('*')

  await notify('sms.received', { type: 'sms.received', data: row })

  if (awareness && row.passport_id) {
    await awareness.record({
      passport_id: row.passport_id,
      session_id: row.session_id,
      ts: row.created_at || new Date(),
      channel: 'sms',
      direction: 'expression',
      source: 'sms',
      content_id: `sms-inbox:${row.id}`,
      text: row.body || (keyword ? `[${keyword}]` : ''),
      meta: { from: row.from, to: row.to, keyword: row.keyword, provider: row.provider },
    }).catch(err => logger.warn({ err, inboxId: row.id }, 'awareness.record failed'))
  }

  res.status(200).end()
}
