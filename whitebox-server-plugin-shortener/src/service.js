// The shortener's brain: create links, resolve a click into a redirect (minting
// a single-use claim token when the link can bind identity), and claim a token
// into a hard-bind (stitching anonymous history via the core passport merge).

import * as store from './store.js'
import { newCode, newClaimToken } from './codes.js'

let passports, awareness, logger, config

export function init(deps) {
  passports = deps.passports
  awareness = deps.awareness
  logger    = deps.logger
  config    = deps.config            // { baseUrl, host, codeLength, defaultTtlSec, identityTtlSec, claimTtlSec, param }
}

class BadRequest extends Error { constructor(m) { super(m); this.status = 400 } }

// ── create ───────────────────────────────────────────────────────────────

export async function createLink(input = {}) {
  const { url, passport_id, identify, data = {}, label = null, code: vanity,
          ttlSec = config.defaultTtlSec, identityTtlSec = config.identityTtlSec, maxClicks = null } = input

  let dest
  try { dest = new URL(url) } catch { throw new BadRequest('url must be an absolute URL') }
  if (!/^https?:$/.test(dest.protocol)) throw new BadRequest('url must be http(s)')

  // Bind to a known customer: a given passport_id (canonicalized) or an existing
  // passport resolved from identity. Unresolved identity is kept for click time.
  let bound = null
  if (passport_id) bound = await passports.resolve(passport_id)
  else if (identify?.email) bound = (await passports.findByIdentity('email', identify.email))?.id || null
  else if (identify?.phone) bound = (await passports.findByIdentity('phone', identify.phone))?.id || null

  const now = new Date()
  const code = vanity || await uniqueCode()
  const row = await store.insertLink({
    code, url, data, identify: identify || null, label, passport_id: bound, max_clicks: maxClicks,
    expires_at:          ttlSec         ? new Date(now.getTime() + ttlSec * 1000) : null,
    identity_expires_at: identityTtlSec ? new Date(now.getTime() + identityTtlSec * 1000) : null,
  })
  return { code, short_url: shortUrl(code), expires_at: row.expires_at }
}

// ── redirect (the hot path) ──────────────────────────────────────────────
// Returns { location } to 302 to, or null for an unknown/dead code. Idempotent:
// each call mints a fresh token and never consumes identity (scanner-safe).

export async function resolveRedirect(code, ctx = {}) {
  const link = await store.getLink(code)
  if (!link) return null
  if (link.expires_at && new Date(link.expires_at) < new Date()) return null   // dead link

  store.bumpClicks(code).catch(() => {})

  if (!bindable(link)) return { location: link.url }   // campaign / consumed / window-passed → plain redirect

  const token = newClaimToken()
  await store.insertClick({
    code, claim_token: token,
    expires_at: new Date(Date.now() + config.claimTtlSec * 1000),
    ip: ctx.ip || null, user_agent: ctx.user_agent || null,
  })
  return { location: withToken(link.url, token) }
}

// ── claim (anonymous browser → known customer) ────────────────────────────

export async function claim(token, visitorPassportId) {
  if (!token) return { bound: false }
  const click = await store.getClick(token)
  if (!click || click.claimed_at || new Date(click.expires_at) < new Date()) return { bound: false }

  // Win the ticket FIRST (atomic single-use) so a forwarded/replayed link or a
  // race can't double-bind. Only the winner proceeds to the merge.
  const now = new Date()
  const won = await store.claimToken(token, now)
  if (!won) return { bound: false }

  const link = await store.getLink(click.code)
  if (!link) return { bound: false }

  const target  = await targetPassport(link)
  const visitor = visitorPassportId ? await passports.resolve(visitorPassportId) : null

  let bound
  if (target) {
    // hard-bind: stitch the anonymous browsing passport onto the customer
    if (visitor && visitor !== target) await passports.merge(target, visitor)
    bound = target
  } else {
    // identity-only link with no existing passport: attach the identity to the
    // visitor (mint if needed); link() merges on collision.
    bound = visitor || await passports.identify(null)
    if (link.identify) await passports.link(bound, identifyItems(link.identify))
    bound = await passports.resolve(bound)
  }

  await store.consumeIdentity(link.code, now)           // single-use identity — disarm
  await store.setClickPassport(token, bound)
  if (link.identify) await passports.link(bound, identifyItems(link.identify)).catch(() => {})

  await awareness?.record?.({
    passport_id: bound, ts: now, channel: 'web', direction: 'expression', source: 'shortlink',
    content_id: `shortlink:${link.code}`, content_url: link.url,
    text: arrivalText(link), meta: { code: link.code, label: link.label, ...(link.data || {}) },
  }).catch?.(err => logger?.warn?.({ err }, 'shortener: awareness record failed'))

  return { bound: true, passport_id: bound, data: link.data || {} }
}

export async function linkStats(code) {
  const link = await store.getLink(code)
  if (!link) return null
  const clicks = await store.clickStats(code)
  return {
    code: link.code, url: link.url, passport_id: link.passport_id, label: link.label,
    expires_at: link.expires_at, identity_consumed_at: link.identity_consumed_at,
    click_count: link.click_count, clicks,
  }
}

export const listLinks = (opts) => store.listLinks(opts)

// ── helpers ────────────────────────────────────────────────────────────────

function bindable(link) {
  if (!link.passport_id && !link.identify) return false           // campaign link: nothing to bind
  if (link.identity_consumed_at) return false                     // already used (single-use)
  if (link.identity_expires_at && new Date(link.identity_expires_at) < new Date()) return false
  return true
}

async function targetPassport(link) {
  if (link.passport_id) return passports.resolve(link.passport_id)
  if (link.identify?.email) return (await passports.findByIdentity('email', link.identify.email))?.id || null
  if (link.identify?.phone) return (await passports.findByIdentity('phone', link.identify.phone))?.id || null
  return null
}

// Auto handoff: a clean fragment normally (kept out of the destination's server
// logs); fall back to a query param when the destination already uses a fragment
// (hash router / anchor), where #wb= would collide.
function withToken(dest, token) {
  const u = new URL(dest)
  if (u.hash) u.searchParams.set(config.param, token)
  else u.hash = `${config.param}=${token}`
  return u.toString()
}

function identifyItems(identify) {
  const items = []
  if (identify.email) items.push({ type: 'email', name: 'email', value: identify.email })
  if (identify.phone) items.push({ type: 'phone', name: 'e164', value: identify.phone })
  if (identify.external_id) items.push({ type: 'user', name: 'external_id', value: String(identify.external_id) })
  return items
}

const arrivalText = (link) =>
  `Arrived via ${link.label || link.data?.utm_campaign || 'short link'} → ${link.url}`

const shortUrl = (code) => `${config.baseUrl.replace(/\/$/, '')}/${code}`

async function uniqueCode(attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    const code = newCode(config.codeLength)
    if (!(await store.getLink(code))) return code
  }
  throw new Error('shortener: could not allocate a unique code')
}
