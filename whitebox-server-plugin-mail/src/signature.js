import crypto from 'crypto'

// Dependencies captured once via init() — module-level singleton, no
// wrapping factory closure. Matches the core pattern.
let webhookSigningKey
let replayWindowMs
let logger

export function init(deps) {
  webhookSigningKey = deps.webhookSigningKey
  replayWindowMs = deps.replayWindowMs
  logger = deps.logger
}

function timingSafeHexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch {
    return false
  }
}

function isFresh(timestamp) {
  const ts = Number(timestamp) * 1000
  if (!Number.isFinite(ts)) return false
  return Math.abs(Date.now() - ts) <= replayWindowMs
}

export function verify(sig, label) {
  if (!sig?.timestamp || !sig?.token || !sig?.signature) {
    logger.warn('%s webhook missing signature fields', label)
    return false
  }

  if (!isFresh(sig.timestamp)) {
    logger.warn('%s webhook timestamp outside replay window: %s', label, sig.timestamp)
    return false
  }

  const expected = crypto.createHmac('sha256', webhookSigningKey).update(sig.timestamp + sig.token).digest('hex')
  if (!timingSafeHexEqual(expected, String(sig.signature))) {
    logger.warn('%s webhook signature mismatch', label)
    return false
  }

  return true
}
