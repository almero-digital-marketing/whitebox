// Engagement plugin — automatic text + image + video trackers + manual section helper.
// WS-primary, sendBeacon fallback on unload.

import createText from './text.js'
import createImage from './image.js'
import createVideo from './video.js'

const DEFAULT_FLUSH_INTERVAL_MS = 5000
const DEFAULT_BATCH_SIZE = 10

export default function engagementPlugin(localOptions = {}) {
  return {
    name: 'engagement',
    install(core) {
      const { transport, http, queue, emitter, logger, config: pluginConfig = {}, deepMerge } = core
      const options = deepMerge ? deepMerge(pluginConfig, localOptions) : { ...pluginConfig, ...localOptions }

      const buffer = []
      let flushTimer = null
      let textTracker = null
      let imageTracker = null
      let videoTracker = null

      function enqueue(event) {
        buffer.push(event)
        if (buffer.length >= (options.batchSize ?? DEFAULT_BATCH_SIZE)) flush()
        else if (!flushTimer) scheduleFlush()
      }

      function scheduleFlush() {
        flushTimer = setTimeout(flush, options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS)
      }

      function flush() {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
        if (!buffer.length) return
        const batch = buffer.splice(0)
        if (transport?.isConnected?.() && transport.send('engagement.batch', { events: batch })) return
        http.request('/engagement/events', { method: 'POST', body: { events: batch } })
          .catch(err => logger?.warn?.('engagement flush failed', err))
      }

      // Final flush on page hide / unload via sendBeacon
      if (typeof window !== 'undefined') {
        const beaconFlush = () => {
          if (!buffer.length) return
          const batch = buffer.splice(0)
          http.beacon('/engagement/events', { events: batch })
        }
        window.addEventListener('pagehide', beaconFlush)
        window.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'hidden') beaconFlush()
        })
      }

      // Manual section helper — for code that wants to emit a section-read
      // event directly (e.g. analytics from a non-DOM context).
      function section({ id, url, text, dwell_ms, meta } = {}) {
        if (!text) return
        enqueue({ type: 'engagement.section', ts: new Date().toISOString(), id, url, text, dwell_ms, meta })
      }

      // --- Automatic text tracking ---
      const textOptions = options.text === false ? null : (options.text ?? {})
      if (textOptions && textOptions.enabled !== false) {
        textTracker = createText({
          options: textOptions,
          onRead: ({ id, kind, level, text: chunk, length_chars, ms_spent, url, partial }) => {
            enqueue({
              type: 'engagement.text',
              ts: new Date().toISOString(),
              id, kind, level, text: chunk, length_chars, ms_spent, url, partial,
            })
            emitter.emit('engagement.text', { id, kind, level, length_chars, ms_spent, partial })
          },
        })
        if (typeof window !== 'undefined') queue(async () => textTracker.start())
      }

      // --- Automatic image tracking ---
      const imageOptions = options.image === false ? null : (options.image ?? {})
      if (imageOptions && imageOptions.enabled !== false) {
        imageTracker = createImage({
          options: imageOptions,
          onRead: ({ id, kind, src, alt, width, height, ms_spent, url, partial }) => {
            enqueue({
              type: 'engagement.image',
              ts: new Date().toISOString(),
              id, kind, src, alt, width, height, ms_spent, url, partial,
            })
            emitter.emit('engagement.image', { id, src, alt, ms_spent, partial })
          },
        })
        if (typeof window !== 'undefined') queue(async () => imageTracker.start())
      }

      // --- Automatic video tracking ---
      const videoOptions = options.video === false ? null : (options.video ?? {})
      if (videoOptions && videoOptions.enabled !== false) {
        videoTracker = createVideo({
          options: videoOptions,
          onRead: ({ id, kind, src, duration_s, intervals, total_watched_s, completion_pct, ms_spent, url, muted, partial }) => {
            enqueue({
              type: 'engagement.video',
              ts: new Date().toISOString(),
              id, kind, src, duration_s, intervals,
              total_watched_s, completion_pct, ms_spent, url, muted, partial,
            })
            emitter.emit('engagement.video', { id, src, duration_s, total_watched_s, completion_pct, partial })
          },
        })
        if (typeof window !== 'undefined') queue(async () => videoTracker.start())
      }

      function stop() {
        textTracker?.stop()
        imageTracker?.stop()
        videoTracker?.stop()
        if (flushTimer) clearTimeout(flushTimer)
      }

      core.attach('engagement', {
        section, flush, stop,
        text: textTracker,
        image: imageTracker,
        video: videoTracker,
      })
    },
  }
}
