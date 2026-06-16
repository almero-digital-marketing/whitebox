// Handler for automatic text engagement events (paragraphs + headings).
// Client side: src/plugins/engagement/text/ emits these via the auto-tracker.
// Maps the flat event payload to an awareness exposure with source='text'.

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
    source: 'text',
    content_id: msg.id || null,
    content_url: msg.url || null,
    text: msg.text,
    dwell_ms: msg.ms_spent ?? null,
    meta: {
      kind: msg.kind || 'paragraph',         // 'paragraph' | 'heading'
      level: msg.level ?? null,              // 1–6 for headings
      length_chars: msg.length_chars ?? msg.text.length,
      partial: msg.partial ?? false,
    },
  }).catch(err => logger.warn({ err }, 'text.consume failed'))
}
