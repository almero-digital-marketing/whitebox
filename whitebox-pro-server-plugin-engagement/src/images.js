// Handler for image engagement events.
//
// New client payload shape:
//   { id, kind: 'image', src, alt, width, height, ms_spent, url (page), partial }
//
// `alt` (when present) is used as a cheap "provided description" — skips the
// OpenAI Vision call entirely. Without `alt`, the content cache fetches the
// image, resizes via sharp, and asks Vision for a description (cached per src).

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
  const imageUrl = msg?.src || msg?.url   // backward compat: old payload used `url`
  if (!imageUrl) return

  try {
    // Use alt text (or the legacy `description` field) as the description if
    // provided; otherwise resolve via Vision. trim() ensures whitespace-only
    // alt doesn't accidentally skip Vision.
    const altDesc = (msg.alt && msg.alt.trim()) || (msg.description && msg.description.trim()) || undefined
    const resolved = await content.resolveImage(imageUrl, altDesc)
    if (!resolved?.text) return

    // The image url and the page url may differ — record both for proper attribution.
    const pageUrl = msg.url && msg.url !== imageUrl ? msg.url : null

    await awareness.record({
      passport_id: visitor.passportId,
      session_id: visitor.sessionId,
      ts: msg.ts ? new Date(msg.ts) : new Date(),
      channel: 'web',
      direction: 'exposure',
      source: 'image',
      content_id: msg.id || imageUrl,
      content_url: imageUrl,
      text: resolved.text,
      dwell_ms: msg.ms_spent ?? msg.dwell_ms ?? null,
      meta: {
        page_url: pageUrl,
        alt: msg.alt || null,
        width: msg.width ?? null,
        height: msg.height ?? null,
        partial: msg.partial ?? false,
        source_kind: resolved.source_kind || null,  // 'auto' | 'provided'
      },
    })
  } catch (err) {
    logger.warn({ err, url: imageUrl }, 'image.consume failed')
  }
}
