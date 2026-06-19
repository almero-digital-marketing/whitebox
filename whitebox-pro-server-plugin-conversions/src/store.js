// Store — the conversion-events audit log. Module-level singleton (init() once),
// matching the core pattern. Gives us idempotency (seen by event_id) plus a
// queryable record of what we sent where.

const TABLE = 'whitebox_conversion_events'

let db

export function init(deps) { db = deps.db }

// Has this event_id already been processed? (sendBeacon may double-fire.)
export async function seen(eventId) {
  return db(TABLE).where({ event_id: eventId }).first()
}

export async function insert(row) {
  const [out] = await db(TABLE).insert(row).returning('*')
  return out
}

// Recent events for a passport, newest first.
export async function listForPassport(passportId, { limit = 50, offset = 0 } = {}) {
  return db(TABLE)
    .where({ passport_id: passportId })
    .orderBy('received_at', 'desc')
    .limit(limit)
    .offset(offset)
}

// Recent events across the base, newest first.
export async function list({ limit = 50, offset = 0 } = {}) {
  return db(TABLE)
    .orderBy('received_at', 'desc')
    .limit(limit)
    .offset(offset)
}
