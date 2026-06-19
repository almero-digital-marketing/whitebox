// Handler for link-click engagement events. A deliberate click is a strong
// intent signal, so it's recorded as an EXPRESSION (the visitor actively
// signalled), not a passive exposure, with full engagement depth. The recorded
// text is the link's label (anchor text or the data-wb-link override), so it
// embeds as "what they clicked toward" — recallable as interest.

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
    direction: 'expression',                 // an active click, not passive scrolling
    source: 'link',
    content_id: msg.id || null,
    content_url: msg.href || null,
    text: msg.text,
    meta: {
      kind: 'link',
      href: msg.href || null,
      engagement: 1,                          // a click is full intent
      depth: 'click',
    },
  }).catch(err => logger.warn({ err }, 'link.consume failed'))
}
