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

// Depth of a read, so a skimmed 3-word heading is not weighted like a fully-read
// 100-word paragraph. Driven by how much content was actually consumed:
//   words ≈ chars / 5, halved for a partial (unfinished) read, normalised so
//   ~80 words of genuine reading ≈ 1.0 and a short heading lands near the floor.
// Returns { engagement: 0–1, depth: 'glance' | 'read' | 'deep' }.
const FULL_READ_WORDS = 80
export function readDepth({ length_chars = 0, partial = false } = {}) {
  const words = Math.max(1, Math.round((length_chars || 0) / 5))
  const wordsRead = partial ? words * 0.5 : words
  const engagement = Math.max(0.02, Math.min(1, wordsRead / FULL_READ_WORDS))
  const depth = words < 12 ? 'glance' : words < 50 ? 'read' : 'deep'
  return { engagement: Math.round(engagement * 100) / 100, depth }
}

export async function consume(visitor, msg) {
  if (!msg?.text) return
  const length_chars = msg.length_chars ?? msg.text.length
  const partial = msg.partial ?? false
  const { engagement, depth } = readDepth({ length_chars, partial })
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
      length_chars,
      partial,
      engagement,                            // 0–1 depth weight (heading ≈ 0.05, full paragraph ≈ 1)
      depth,                                 // 'glance' | 'read' | 'deep'
    },
  }).catch(err => logger.warn({ err }, 'text.consume failed'))
}
