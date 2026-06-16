// Video engagement: tracks actual playback (not viewport time).
//
// Per <video> element, maintains a set of disjoint watched intervals — the
// seconds the user actually played while the page was active and the video
// was visible (or in PiP / fullscreen).
//
// Emits one `engagement.video` event per "watch session". A session ends when:
//   - video reaches `ended`
//   - user pauses ≥ flushAfterPausedMs (default 30s) without resuming
//   - element scrolls out of viewport while paused
//   - page hides / unloads (handled via shared engagement plugin)
//   - element removed from DOM (SPA navigation)

import createOrchestrator from 'whitebox-client/orchestrator'
import createActivity from 'whitebox-client/activity'
import { elementId, buildScannerHooks } from './scanner.js'
import {
  DEFAULT_VIDEO_SELECTOR,
  DEFAULT_VIDEO_EXCLUDE,
  DEFAULT_VIDEO_ID_ATTR,
} from './scanner.js'

const DEFAULTS = {
  flushAfterPausedMs: 30_000,
  minViewportRatio: 0.5,
  rootMargin: '0% 0% 0% 0%',
  countMuted: true,
}

// Merge overlapping/adjacent intervals into a disjoint sorted set.
export function mergeIntervals(intervals) {
  if (!intervals.length) return []
  const sorted = intervals
    .filter(i => i && i.end_s > i.start_s)
    .slice()
    .sort((a, b) => a.start_s - b.start_s)
  if (!sorted.length) return []
  const out = [{ ...sorted[0] }]
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1]
    const cur = sorted[i]
    if (cur.start_s <= last.end_s) {
      last.end_s = Math.max(last.end_s, cur.end_s)
    } else {
      out.push({ ...cur })
    }
  }
  return out
}

function createVideoTracker({ activity, onRead, options = {} } = {}) {
  const cfg = { ...DEFAULTS, ...options }
  const states = new Map()
  let io = null
  let started = false

  function ensureState(video) {
    let s = states.get(video)
    if (s) return s
    s = {
      el: video,
      id: elementId(video, { idAttribute: cfg.idAttribute }),
      url: typeof window !== 'undefined' ? window.location.href : null,
      intervals: [],
      currentInterval: null,
      visible: false,
      inPip: false,
      inFullscreen: false,
      flushTimer: null,
      handlers: null,
    }
    states.set(video, s)
    return s
  }

  function isEffectivelyVisible(s) {
    return s.visible || s.inPip || s.inFullscreen
  }

  function shouldRecord(s) {
    if (!isEffectivelyVisible(s)) return false
    if (!activity.isOpen()) return false
    if (!cfg.countMuted && s.el.muted) return false
    return true
  }

  function startInterval(s) {
    if (s.currentInterval) return
    const t = s.el.currentTime
    s.currentInterval = { start_s: t, end_s: t }
    if (s.flushTimer) { clearTimeout(s.flushTimer); s.flushTimer = null }
  }

  // closeInterval(s)         → end interval at video.currentTime (default)
  // closeInterval(s, atTime) → end interval at the supplied timestamp
  //
  // The seeking event fires when currentTime is already the seek target —
  // not the position playback actually reached. Pass `s.currentInterval.end_s`
  // (last value set by timeupdate) to avoid extending into unwatched territory.
  function closeInterval(s, atTime) {
    if (!s.currentInterval) return
    if (typeof atTime === 'number') {
      s.currentInterval.end_s = atTime
    } else {
      s.currentInterval.end_s = s.el.currentTime
    }
    if (s.currentInterval.end_s > s.currentInterval.start_s) {
      s.intervals = mergeIntervals([...s.intervals, s.currentInterval])
    }
    s.currentInterval = null
  }

  function scheduleIdleFlush(s) {
    if (s.flushTimer) clearTimeout(s.flushTimer)
    s.flushTimer = setTimeout(() => flush(s, false), cfg.flushAfterPausedMs)
  }

  function tick(s) {
    if (!s.currentInterval) return
    s.currentInterval.end_s = s.el.currentTime
  }

  function handleIntersect(entries) {
    for (const entry of entries) {
      const s = states.get(entry.target)
      if (!s) continue
      const nowVisible = entry.isIntersecting && entry.intersectionRatio >= cfg.minViewportRatio
      s.visible = nowVisible
      if (!isEffectivelyVisible(s) && s.currentInterval) {
        closeInterval(s)
        scheduleIdleFlush(s)
      }
    }
  }

  function attach(s) {
    const onPlay = () => {
      if (!shouldRecord(s)) return
      startInterval(s)
    }
    const onPause = () => {
      closeInterval(s)
      scheduleIdleFlush(s)
    }
    const onTimeupdate = () => {
      if (!shouldRecord(s)) {
        if (s.currentInterval) closeInterval(s)
        return
      }
      if (!s.currentInterval) startInterval(s)
      tick(s)
    }
    const onEnded = () => {
      closeInterval(s)
      flush(s, false)
    }
    const onSeeking = () => {
      // Don't extend to the seek target — close at the last watched position
      // (tracked by the last timeupdate, stored on s.currentInterval.end_s).
      if (s.currentInterval) closeInterval(s, s.currentInterval.end_s)
    }
    const onSeeked  = () => {
      if (!s.el.paused && shouldRecord(s)) startInterval(s)
    }
    const onEnterPip = () => { s.inPip = true }
    const onLeavePip = () => { s.inPip = false }
    const onFullscreenChange = () => {
      s.inFullscreen = document.fullscreenElement === s.el
      if (!isEffectivelyVisible(s) && s.currentInterval) closeInterval(s)
    }

    s.handlers = { onPlay, onPause, onTimeupdate, onEnded, onSeeking, onSeeked, onEnterPip, onLeavePip, onFullscreenChange }
    s.el.addEventListener('play', onPlay)
    s.el.addEventListener('pause', onPause)
    s.el.addEventListener('timeupdate', onTimeupdate)
    s.el.addEventListener('ended', onEnded)
    s.el.addEventListener('seeking', onSeeking)
    s.el.addEventListener('seeked', onSeeked)
    s.el.addEventListener('enterpictureinpicture', onEnterPip)
    s.el.addEventListener('leavepictureinpicture', onLeavePip)
    document.addEventListener('fullscreenchange', onFullscreenChange)
  }

  function detach(s) {
    if (!s.handlers) return
    const h = s.handlers
    s.el.removeEventListener('play', h.onPlay)
    s.el.removeEventListener('pause', h.onPause)
    s.el.removeEventListener('timeupdate', h.onTimeupdate)
    s.el.removeEventListener('ended', h.onEnded)
    s.el.removeEventListener('seeking', h.onSeeking)
    s.el.removeEventListener('seeked', h.onSeeked)
    s.el.removeEventListener('enterpictureinpicture', h.onEnterPip)
    s.el.removeEventListener('leavepictureinpicture', h.onLeavePip)
    document.removeEventListener('fullscreenchange', h.onFullscreenChange)
    s.handlers = null
    if (s.flushTimer) { clearTimeout(s.flushTimer); s.flushTimer = null }
  }

  function flush(s, partial) {
    if (!s.intervals.length && !s.currentInterval) return
    if (s.currentInterval) closeInterval(s)
    if (!s.intervals.length) return
    if (s.flushTimer) { clearTimeout(s.flushTimer); s.flushTimer = null }

    const duration_s = Number.isFinite(s.el.duration) ? s.el.duration : null
    const total_watched_s = s.intervals.reduce((sum, i) => sum + (i.end_s - i.start_s), 0)
    const completion_pct = duration_s ? Math.round((total_watched_s / duration_s) * 1000) / 10 : null

    onRead?.({
      id: s.id,
      kind: 'video',
      src: s.el.currentSrc || s.el.src || null,
      duration_s,
      intervals: s.intervals.map(i => ({
        start_s: Math.round(i.start_s * 100) / 100,
        end_s: Math.round(i.end_s * 100) / 100,
      })),
      total_watched_s: Math.round(total_watched_s * 100) / 100,
      completion_pct,
      ms_spent: Math.round(total_watched_s * 1000),
      url: s.url,
      muted: !!s.el.muted,
      partial,
    })

    // New watch session starts fresh.
    s.intervals = []
  }

  function flushAllPartial() {
    for (const s of states.values()) flush(s, true)
  }

  function observe(video) {
    if (!io || states.has(video)) return
    const s = ensureState(video)
    attach(s)
    io.observe(video)
  }

  function unobserve(video) {
    const s = states.get(video)
    if (!s) return
    flush(s, true)
    detach(s)
    try { io?.unobserve(video) } catch { /* ignore */ }
    states.delete(video)
  }

  function onPageHide() { flushAllPartial() }
  function onVisibilityChange() {
    if (document.visibilityState === 'hidden') flushAllPartial()
  }

  function start() {
    if (started || typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') return
    started = true
    io = new IntersectionObserver(handleIntersect, {
      rootMargin: cfg.rootMargin,
      threshold: [0, cfg.minViewportRatio, 1],
    })
    window.addEventListener('pagehide', onPageHide)
    document.addEventListener('visibilitychange', onVisibilityChange)
  }

  function stop() {
    if (!started) return
    started = false
    flushAllPartial()
    for (const s of states.values()) detach(s)
    states.clear()
    try { io?.disconnect() } catch { /* ignore */ }
    io = null
    window.removeEventListener('pagehide', onPageHide)
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }

  return { start, stop, observe, unobserve, _states: states }
}

export default function createVideoEngagements({ onRead, options = {} } = {}) {
  const idAttribute = options.idAttribute ?? DEFAULT_VIDEO_ID_ATTR
  // Idle gate disabled for video — active playback IS engagement, even without keystrokes.
  const activity = createActivity({ idleAfterMs: Infinity })

  const inner = createVideoTracker({
    activity,
    onRead,
    options: { ...options, idAttribute },
  })

  const tracker = {
    observe: inner.observe,
    unobserve: inner.unobserve,
    start: () => { activity.attach(); inner.start() },
    stop:  () => { inner.stop(); activity.detach() },
  }

  const scannerOptions = {
    selector:        options.selector        ?? DEFAULT_VIDEO_SELECTOR,
    excludeSelector: options.excludeSelector ?? DEFAULT_VIDEO_EXCLUDE,
    idAttribute,
  }
  return createOrchestrator({ tracker, ...buildScannerHooks(scannerOptions) })
}

// Exported for testing
export { createVideoTracker }
