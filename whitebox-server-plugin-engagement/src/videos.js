// Handler for video engagement events.
//
// New client payload shape (one event per watch session):
//   {
//     id, kind: 'video', src, duration_s,
//     intervals: [{ start_s, end_s }, ...],
//     total_watched_s, completion_pct, ms_spent, url, muted, partial, ts
//   }
//
// The transcript (Whisper + frame Vision) is cached per src in the content
// table. We slice it to only the intervals the user actually watched, then
// record one exposure with that sliced text.

import * as content from './content.js'

// Dependencies captured once via init() — module-level singletons, no
// wrapping factory closure. Matches the core pattern (passports, sessions, …).
let awareness
let logger

export function init(deps) {
  awareness = deps.awareness
  logger = deps.logger
}

export async function consume(visitor, msg) {
  const url = msg?.src || msg?.url
  if (!url) return

  try {
    const resolved = await content.resolveVideo(url, msg.transcript)

    // Prefer the new intervals[] shape; fall back to legacy single-range fields.
    const intervals = msg.intervals
      || (msg.start_s != null
          ? [{ start_s: msg.start_s, end_s: msg.end_s }]
          : null)

    const text = content.sliceVideo(resolved, intervals)
    if (!text) return

    const pageUrl = msg.url && msg.url !== url ? msg.url : null

    await awareness.record({
      passport_id: visitor.passportId,
      session_id: visitor.sessionId,
      ts: msg.ts ? new Date(msg.ts) : new Date(),
      channel: 'web',
      direction: 'exposure',
      source: 'video',
      content_id: msg.id || url,
      content_url: url,
      text,
      dwell_ms: msg.ms_spent ?? null,
      meta: {
        page_url: pageUrl,
        intervals: intervals || null,
        duration_s: msg.duration_s ?? null,
        total_watched_s: msg.total_watched_s ?? null,
        completion_pct: msg.completion_pct ?? null,
        muted: msg.muted ?? null,
        partial: msg.partial ?? false,
      },
    })
  } catch (err) {
    logger.warn({ err, url }, 'video.consume failed')
  }
}
