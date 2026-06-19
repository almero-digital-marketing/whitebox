// Routes a message to the right provider (by recipient) and delegates the send.
// Returns the provider name alongside the id so the outbox can record which
// provider handled the row (and match its later DLR/status callback).
let router

export function init(deps) {
  router = deps.router
}

export function providerFor(to) {
  return router.forNumber(to)
}

export async function send({ to, from, body, media }) {
  const provider = router.forNumber(to)
  const out = await provider.send({ to, from, body, media })
  return { messageId: out?.messageId || null, provider: provider.name }
}
