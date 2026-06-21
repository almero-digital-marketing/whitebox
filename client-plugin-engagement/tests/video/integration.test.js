import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import createVideo, { mergeIntervals } from '../../src/video.js'

class FakeIO {
  static instances = []
  constructor(cb, options) {
    this.cb = cb
    this.options = options
    this.observed = new Set()
    FakeIO.instances.push(this)
  }
  observe(el) { this.observed.add(el) }
  unobserve(el) { this.observed.delete(el) }
  disconnect() { this.observed.clear() }
  triggerIntersect(el, ratio) {
    this.cb([{ target: el, isIntersecting: ratio > 0, intersectionRatio: ratio }])
  }
  static latest() { return FakeIO.instances[FakeIO.instances.length - 1] }
}

// Tiny helper: create a fake <video> element that we control programmatically.
function fakeVideo({ id, src = '/v.mp4', duration = 240 } = {}) {
  const video = document.createElement('video')
  if (id) video.setAttribute('data-wb-video', id)
  else video.setAttribute('data-wb-video', '')
  video.src = src
  // Override read-only props for testing
  Object.defineProperty(video, 'duration', { value: duration, configurable: true, writable: true })
  Object.defineProperty(video, 'currentTime', { value: 0, configurable: true, writable: true })
  Object.defineProperty(video, 'currentSrc', { value: src, configurable: true, writable: true })
  Object.defineProperty(video, 'paused', { value: true, configurable: true, writable: true })
  Object.defineProperty(video, 'muted', { value: false, configurable: true, writable: true })
  document.body.appendChild(video)
  return video
}

function fire(video, event) {
  video.dispatchEvent(new Event(event))
}

describe('video.mergeIntervals', () => {
  it('merges overlapping intervals', () => {
    expect(mergeIntervals([{ start_s: 0, end_s: 10 }, { start_s: 5, end_s: 15 }]))
      .toEqual([{ start_s: 0, end_s: 15 }])
  })

  it('merges touching intervals', () => {
    expect(mergeIntervals([{ start_s: 0, end_s: 5 }, { start_s: 5, end_s: 10 }]))
      .toEqual([{ start_s: 0, end_s: 10 }])
  })

  it('keeps disjoint intervals', () => {
    expect(mergeIntervals([{ start_s: 0, end_s: 5 }, { start_s: 10, end_s: 15 }]))
      .toEqual([{ start_s: 0, end_s: 5 }, { start_s: 10, end_s: 15 }])
  })

  it('sorts unordered input', () => {
    expect(mergeIntervals([{ start_s: 10, end_s: 15 }, { start_s: 0, end_s: 5 }]))
      .toEqual([{ start_s: 0, end_s: 5 }, { start_s: 10, end_s: 15 }])
  })

  it('drops zero-length intervals', () => {
    expect(mergeIntervals([{ start_s: 5, end_s: 5 }, { start_s: 0, end_s: 10 }]))
      .toEqual([{ start_s: 0, end_s: 10 }])
  })
})

describe('video engagement (opt-in only)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    FakeIO.instances = []
    globalThis.IntersectionObserver = FakeIO
  })

  afterEach(() => {
    delete globalThis.IntersectionObserver
  })

  it('observes only <video data-wb-video> elements on initial scan', () => {
    document.body.innerHTML = `
      <video src="/a.mp4"></video>
      <video src="/b.mp4" data-wb-video></video>
      <video src="/c.mp4" data-wb-video="intro"></video>
    `
    const t = createVideo({ onRead: vi.fn() })
    t.start()
    expect(FakeIO.latest().observed.size).toBe(2)
    t.stop()
  })

  it('emits a video event when playback ends', async () => {
    const video = fakeVideo({ id: 'intro', src: 'https://x/v.mp4', duration: 100 })
    const onRead = vi.fn()
    const t = createVideo({ onRead })
    t.start()

    FakeIO.latest().triggerIntersect(video, 1.0)

    // Simulate: play from 0 to 30, then ended
    video.paused = false
    fire(video, 'play')
    video.currentTime = 30
    fire(video, 'timeupdate')
    fire(video, 'ended')

    expect(onRead).toHaveBeenCalledTimes(1)
    const payload = onRead.mock.calls[0][0]
    expect(payload).toMatchObject({
      id: 'intro',
      kind: 'video',
      src: 'https://x/v.mp4',
      duration_s: 100,
      intervals: [{ start_s: 0, end_s: 30 }],
      total_watched_s: 30,
      completion_pct: 30,
      partial: false,
    })
    t.stop()
  })

  it('accumulates disjoint intervals from scrubbing (with merge)', async () => {
    const video = fakeVideo({ id: 'demo', duration: 100 })
    const onRead = vi.fn()
    const t = createVideo({ onRead })
    t.start()
    FakeIO.latest().triggerIntersect(video, 1.0)

    // Watch 0 → 10
    video.paused = false
    video.currentTime = 0
    fire(video, 'play')
    video.currentTime = 10
    fire(video, 'timeupdate')

    // Seek to 50
    video.currentTime = 50
    fire(video, 'seeking')
    fire(video, 'seeked')

    // Watch 50 → 60
    video.currentTime = 60
    fire(video, 'timeupdate')

    // Pause and end
    fire(video, 'pause')
    fire(video, 'ended')

    expect(onRead).toHaveBeenCalledTimes(1)
    const { intervals, total_watched_s } = onRead.mock.calls[0][0]
    expect(intervals.length).toBe(2)
    expect(total_watched_s).toBeCloseTo(20, 1)
    t.stop()
  })

  it('does not accumulate while out of viewport', async () => {
    const video = fakeVideo({ id: 'bg', duration: 100 })
    const onRead = vi.fn()
    const t = createVideo({ onRead })
    t.start()
    // Element is OFF screen
    FakeIO.latest().triggerIntersect(video, 0)

    video.paused = false
    video.currentTime = 0
    fire(video, 'play')
    video.currentTime = 30
    fire(video, 'timeupdate')
    fire(video, 'ended')

    expect(onRead).not.toHaveBeenCalled()
    t.stop()
  })

  it('flushes on pagehide with partial=true', async () => {
    const video = fakeVideo({ id: 'unload-test', duration: 100 })
    const onRead = vi.fn()
    const t = createVideo({ onRead })
    t.start()
    FakeIO.latest().triggerIntersect(video, 1.0)

    video.paused = false
    fire(video, 'play')
    video.currentTime = 15
    fire(video, 'timeupdate')

    // Page hide before ended
    window.dispatchEvent(new Event('pagehide'))

    expect(onRead).toHaveBeenCalledTimes(1)
    expect(onRead.mock.calls[0][0]).toMatchObject({
      partial: true,
    })
    expect(onRead.mock.calls[0][0].intervals).toHaveLength(1)
    t.stop()
  })

  it('flushes after long pause without resume', async () => {
    vi.useFakeTimers()
    const video = fakeVideo({ id: 'paused-test', duration: 100 })
    const onRead = vi.fn()
    const t = createVideo({ onRead, options: { flushAfterPausedMs: 100 } })
    t.start()
    FakeIO.latest().triggerIntersect(video, 1.0)

    video.paused = false
    fire(video, 'play')
    video.currentTime = 10
    fire(video, 'timeupdate')

    // Pause and wait for flush timer
    fire(video, 'pause')
    vi.advanceTimersByTime(150)

    expect(onRead).toHaveBeenCalledTimes(1)
    expect(onRead.mock.calls[0][0]).toMatchObject({
      partial: false,   // graceful flush — not partial
    })
    vi.useRealTimers()
    t.stop()
  })

  it('uses data-wb-video value as stable id; src-hashed fallback', async () => {
    const v1 = fakeVideo({ id: 'first-video', src: 'https://x/a.mp4' })
    const v2 = fakeVideo({ src: 'https://x/b.mp4' })   // empty data-wb-video
    const onRead = vi.fn()
    const t = createVideo({ onRead })
    t.start()
    FakeIO.latest().triggerIntersect(v1, 1.0)
    FakeIO.latest().triggerIntersect(v2, 1.0)

    for (const v of [v1, v2]) {
      v.paused = false
      v.currentTime = 0
      fire(v, 'play')
      v.currentTime = 5
      fire(v, 'timeupdate')
      fire(v, 'ended')
    }

    expect(onRead).toHaveBeenCalledTimes(2)
    const ids = onRead.mock.calls.map(c => c[0].id)
    expect(ids[0]).toBe('first-video')
    expect(ids[1]).toMatch(/^wb:/)
    t.stop()
  })

  it('respects countMuted=false (skips muted playback)', async () => {
    const video = fakeVideo({ id: 'muted-test', duration: 100 })
    video.muted = true
    const onRead = vi.fn()
    const t = createVideo({ onRead, options: { countMuted: false } })
    t.start()
    FakeIO.latest().triggerIntersect(video, 1.0)

    video.paused = false
    fire(video, 'play')
    video.currentTime = 30
    fire(video, 'timeupdate')
    fire(video, 'ended')

    expect(onRead).not.toHaveBeenCalled()
    t.stop()
  })
})
