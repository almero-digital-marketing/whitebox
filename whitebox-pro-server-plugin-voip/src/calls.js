const TABLE = 'whitebox_voip_calls'

let db

export function init(deps) {
  db = deps.db
}

export async function ring({ vaultId, passportId, sessionId, caller, line, tag, date }) {
  await db(TABLE).insert({
    vault_id: vaultId,
    passport_id: passportId,
    session_id: sessionId,
    caller,
    line,
    tag,
    status: 'ringing',
    started_at: date,
  })
}

export async function pick({ vaultId, destination, date }) {
  await db(TABLE).where({ vault_id: vaultId }).update({
    destination,
    status: 'active',
    picked_at: date,
  })
}

export async function end({ vaultId, duration, record, link, transcription, date }) {
  const call = await db(TABLE).where({ vault_id: vaultId }).first()
  if (!call) return null
  await db(TABLE).where({ vault_id: vaultId }).update({
    duration,
    record,
    link,
    transcription,
    status: call.picked_at ? 'ended' : 'missed',
    ended_at: date,
  })
  const updated = await db(TABLE).where({ vault_id: vaultId }).first()
  return updated
}

export async function find(vaultId) {
  const call = await db(TABLE).where({ vault_id: vaultId }).first()
  return call
}
