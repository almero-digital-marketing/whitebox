// Periodically mark outbox rows that have sat in `queued` too long as
// `failed/stuck`. The actual job lives in outbox.markStuck; this file just
// owns the timer lifecycle. Disabled when interval ≤ 0.

import * as outbox from './outbox.js'

const DEFAULT_THRESHOLD_MS      = 10 * 60 * 1000
const DEFAULT_CHECK_INTERVAL_MS = 60 * 1000

export function startStuckReaper(mailConfig, logger) {
  const thresholdMs    = mailConfig.outbox?.stuckThresholdMs    ?? DEFAULT_THRESHOLD_MS
  const checkIntervalMs = mailConfig.outbox?.stuckCheckIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS
  if (checkIntervalMs <= 0) return null

  const timer = setInterval(() => {
    outbox.markStuck(thresholdMs).catch(err => {
      logger.error({ err }, 'Stuck mail reaper tick failed')
    })
  }, checkIntervalMs)
  timer.unref?.()
  return timer
}
