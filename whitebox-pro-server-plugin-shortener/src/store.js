// Data layer for links + clicks. Module-level singleton (init once), matching
// the core pattern.

const LINKS = 'whitebox_short_links'
const CLICKS = 'whitebox_short_clicks'

let db

export function init(deps) { db = deps.db }

// ── links ──────────────────────────────────────────────────────────────────

export async function insertLink(row) {
  const [out] = await db(LINKS).insert(row).returning('*')
  return out
}

export const getLink = (code) => db(LINKS).where({ code }).first()

export const bumpClicks = (code) => db(LINKS).where({ code }).increment('click_count', 1)

export const consumeIdentity = (code, when) =>
  db(LINKS).where({ code }).whereNull('identity_consumed_at').update({ identity_consumed_at: when })

export const listLinks = ({ limit = 50, offset = 0 } = {}) =>
  db(LINKS).orderBy('created_at', 'desc').limit(limit).offset(offset)

// ── clicks ─────────────────────────────────────────────────────────────────

export async function insertClick(row) {
  const [out] = await db(CLICKS).insert(row).returning('*')
  return out
}

export const getClick = (claim_token) => db(CLICKS).where({ claim_token }).first()

// Single-use: win the ticket atomically — set claimed_at only if still null.
// Returns the updated-row count (1 = we won the race, 0 = already claimed).
export const claimToken = (claim_token, when) =>
  db(CLICKS).where({ claim_token }).whereNull('claimed_at').update({ claimed_at: when })

// Stamp who claimed it (after the bind resolves the passport).
export const setClickPassport = (claim_token, passport_id) =>
  db(CLICKS).where({ claim_token }).update({ passport_id })

export async function clickStats(code) {
  const [{ total }] = await db(CLICKS).where({ code }).count('* as total')
  const [{ claimed }] = await db(CLICKS).where({ code }).whereNotNull('claimed_at').count('* as claimed')
  const last = await db(CLICKS).where({ code }).orderBy('ts', 'desc').first()
  return { total: Number(total), claimed: Number(claimed), last_at: last?.ts || null }
}
