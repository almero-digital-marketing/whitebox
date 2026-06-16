// Dependencies captured once via init() — module-level singletons, no
// wrapping factory closure. Matches the core pattern (passports, sessions, …).
let awareness
let logger

export function init(deps) {
  awareness = deps.awareness
  logger = deps.logger
}

export async function consume(visitor, msg) {
  if (!msg?.text) return
  await awareness.record({
    passport_id: visitor.passportId,
    session_id: visitor.sessionId,
    ts: msg.ts ? new Date(msg.ts) : new Date(),
    channel: 'web',
    direction: 'exposure',
    source: 'section',
    content_id: msg.id || msg.url || null,
    content_url: msg.url || null,
    text: msg.text,
    dwell_ms: msg.dwell_ms || null,
    meta: msg.meta || null,
  }).catch(err => logger.warn({ err }, 'section.consume failed'))
}
