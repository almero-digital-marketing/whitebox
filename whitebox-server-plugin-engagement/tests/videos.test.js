import { describe, it, expect, vi } from 'vitest'
import * as videos from '../src/videos.js'
import * as content from '../src/content.js'

// videos depends on the content module (namespace import). Mock it so we can
// assert the calls videos makes into it.
vi.mock('../src/content.js', () => ({
  resolveVideo: vi.fn(),
  sliceVideo: vi.fn(),
}))

// Re-init the module singleton with fresh deps per test, return the namespace
// so existing `videos.consume()` call sites are unchanged.
function makeVideos({ resolved, sliced } = {}) {
  const awareness = { record: vi.fn(async () => ({ id: 1 })) }
  const logger = { warn: vi.fn(), error: vi.fn() }
  content.resolveVideo.mockReset()
  content.sliceVideo.mockReset()
  content.resolveVideo.mockResolvedValue(resolved ?? { url: 'u', kind: 'video', segments: [], text: '' })
  content.sliceVideo.mockReturnValue(sliced ?? 'some transcript slice')
  videos.init({ awareness, logger })
  return { videos, awareness, content, logger }
}

describe('engagement.videos.consume', () => {

  it('resolves video then records sliced text', async () => {
    const { videos, awareness, content } = makeVideos({ sliced: 'Hello world, agent says.' })
    await videos.consume(
      { passportId: 'p1', sessionId: 3 },
      { url: 'https://cdn.x/intro.mp4', start_s: 12, end_s: 30 }
    )
    expect(content.resolveVideo).toHaveBeenCalledWith('https://cdn.x/intro.mp4', undefined)
    expect(content.sliceVideo).toHaveBeenCalled()
    expect(awareness.record).toHaveBeenCalledWith(expect.objectContaining({
      passport_id: 'p1',
      session_id: 3,
      channel: 'web',
      direction: 'exposure',
      source: 'video',
      content_id: 'https://cdn.x/intro.mp4',
      text: 'Hello world, agent says.',
      meta: expect.objectContaining({
        intervals: [{ start_s: 12, end_s: 30 }],   // legacy form converted
      }),
    }))
  })

  it('accepts new intervals[] payload shape', async () => {
    const { videos, content, awareness } = makeVideos({ sliced: 'segments 1 and 3 watched' })
    await videos.consume(
      { passportId: 'p1', sessionId: 5 },
      {
        id: 'intro-video',
        src: 'https://cdn.x/v.mp4',
        kind: 'video',
        duration_s: 240,
        intervals: [{ start_s: 0, end_s: 12.4 }, { start_s: 120, end_s: 180 }],
        total_watched_s: 72.4,
        completion_pct: 30.2,
        ms_spent: 72400,
        url: 'https://example.com/page',
        partial: false,
      }
    )
    expect(content.resolveVideo).toHaveBeenCalledWith('https://cdn.x/v.mp4', undefined)
    expect(content.sliceVideo).toHaveBeenCalledWith(
      expect.any(Object),
      [{ start_s: 0, end_s: 12.4 }, { start_s: 120, end_s: 180 }]
    )
    expect(awareness.record).toHaveBeenCalledWith(expect.objectContaining({
      content_id: 'intro-video',
      content_url: 'https://cdn.x/v.mp4',
      text: 'segments 1 and 3 watched',
      dwell_ms: 72400,
      meta: expect.objectContaining({
        intervals: [{ start_s: 0, end_s: 12.4 }, { start_s: 120, end_s: 180 }],
        duration_s: 240,
        total_watched_s: 72.4,
        completion_pct: 30.2,
        page_url: 'https://example.com/page',
        partial: false,
      }),
    }))
  })

  it('passes client-provided transcript to resolver (cache override)', async () => {
    const { videos, content } = makeVideos()
    const transcript = [{ start_s: 0, end_s: 5, audio: 'hi', visual: null }]
    await videos.consume(
      { passportId: 'p1', sessionId: null },
      { url: 'https://cdn.x/v.mp4', start_s: 0, end_s: 5, transcript }
    )
    expect(content.resolveVideo).toHaveBeenCalledWith('https://cdn.x/v.mp4', transcript)
  })

  it('skips when url missing', async () => {
    const { videos, awareness, content } = makeVideos()
    await videos.consume({ passportId: 'p1', sessionId: null }, {})
    expect(content.resolveVideo).not.toHaveBeenCalled()
    expect(awareness.record).not.toHaveBeenCalled()
  })

  it('skips recording when slice produces empty text', async () => {
    const { videos, awareness } = makeVideos({ sliced: '' })
    await videos.consume(
      { passportId: 'p1', sessionId: null },
      { url: 'https://cdn.x/v.mp4', start_s: 0, end_s: 5 }
    )
    expect(awareness.record).not.toHaveBeenCalled()
  })

  it('swallows resolver errors and logs', async () => {
    const awareness = { record: vi.fn() }
    const logger = { warn: vi.fn(), error: vi.fn() }
    content.resolveVideo.mockReset()
    content.sliceVideo.mockReset()
    content.resolveVideo.mockRejectedValue(new Error('whisper down'))
    videos.init({ awareness, logger })
    await videos.consume({ passportId: 'p1', sessionId: null }, { url: 'https://cdn.x/v.mp4' })
    expect(logger.warn).toHaveBeenCalled()
    expect(awareness.record).not.toHaveBeenCalled()
  })
})
