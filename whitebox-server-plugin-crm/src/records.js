// Data layer for whitebox_crm_records.
//
// Identity is (source, kind, external_id) — the external system's identity,
// not ours. Upserts replace status / starts_at / data and bump updated_at.

const TABLE = 'whitebox_crm_records'

// Dependencies captured once via init() — module-level singleton, no
// wrapping factory closure.
let db

export function init(deps) {
  db = deps.db
}

export async function upsert({ source, kind, external_id, passport_id, status, starts_at, data }) {
  const now = new Date()
  const row = {
    source,
    kind,
    external_id,
    passport_id,
    status: status ?? null,
    starts_at: starts_at ?? null,
    data: data ?? {},
    updated_at: now,
  }

  const [returned] = await db(TABLE)
    .insert({ ...row, created_at: now })
    .onConflict(['source', 'kind', 'external_id'])
    .merge(['passport_id', 'status', 'starts_at', 'data', 'updated_at'])
    .returning('*')

  return returned
}

export async function find({ source, kind, external_id }) {
  return db(TABLE).where({ source, kind, external_id }).first() ?? null
}

export async function listForPassport(passportId, { source, kind, limit = 100, offset = 0 } = {}) {
  const q = db(TABLE).where({ passport_id: passportId })
    .orderBy('starts_at', 'desc')
    .limit(limit)
    .offset(offset)
  if (source) q.andWhere({ source })
  if (kind) q.andWhere({ kind })
  return q
}

export async function remove({ source, kind, external_id }) {
  return db(TABLE).where({ source, kind, external_id }).delete()
}
