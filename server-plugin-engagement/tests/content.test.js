import { describe, it, expect, vi } from 'vitest'
import * as content from '../src/content.js'

function makeDb() {
  const rows = []
  function chain() {
    const filters = []
    const c = {
      where: (cond) => {
        filters.push(r => Object.entries(cond).every(([k, v]) => r[k] === v))
        return c
      },
      first: async () => rows.find(r => filters.every(f => f(r))) || null,
      del: async () => {
        let removed = 0
        for (let i = rows.length - 1; i >= 0; i--) {
          if (filters.every(f => f(rows[i]))) { rows.splice(i, 1); removed++ }
        }
        return removed
      },
      insert: (data) => ({
        onConflict: () => ({
          merge: () => ({
            returning: async () => {
              const existing = rows.find(r => r.url === data.url)
              if (existing) {
                Object.assign(existing, data)
                return [existing]
              }
              rows.push(data)
              return [data]
            },
          }),
        }),
      }),
    }
    return c
  }
  const db = () => chain()
  db.rows = rows
  return db
}

// Re-init the module singleton with fresh deps per test, return the namespace
// so existing `content.resolveImage()` / `content.sliceVideo()` call sites are unchanged.
function makeContent({ ai } = {}) {
  const db = makeDb()
  const config = { engagement: {} }
  const logger = { warn: vi.fn(), error: vi.fn() }
  const openaiMock = ai ?? {
    vision: vi.fn(async () => 'A diagram showing a CI/CD pipeline'),
    transcribe: vi.fn(async () => ({ segments: [{ start: 0, end: 5, text: 'hello world' }], duration: 5 })),
    embed: vi.fn(),
  }
  content.init({ db, ai: openaiMock, config, logger })
  return { content, db, ai: openaiMock, logger }
}

describe('engagement.content cache lookup', () => {

  it('resolveImage returns cached row when present', async () => {
    const { content, db, ai } = makeContent()
    db.rows.push({ url: 'https://x.com/cat.jpg', kind: 'image', text: 'cached desc', source_kind: 'auto' })

    const result = await content.resolveImage('https://x.com/cat.jpg')
    expect(result.text).toBe('cached desc')
    expect(ai.vision).not.toHaveBeenCalled()
  })

  it('resolveImage uses client-provided description without calling Vision', async () => {
    const { content, db, ai } = makeContent()
    const result = await content.resolveImage('https://x.com/new.jpg', 'Custom description from client')
    expect(result.text).toBe('Custom description from client')
    expect(result.source_kind).toBe('provided')
    expect(ai.vision).not.toHaveBeenCalled()
    expect(db.rows).toHaveLength(1)
  })

  it('resolveVideo returns cached row when present', async () => {
    const { content, db, ai } = makeContent()
    db.rows.push({
      url: 'https://x.com/v.mp4',
      kind: 'video',
      text: 'cached transcript',
      segments: [{ start_s: 0, end_s: 5, audio: 'cached transcript', visual: null }],
      source_kind: 'auto',
    })

    const result = await content.resolveVideo('https://x.com/v.mp4')
    expect(result.text).toBe('cached transcript')
    expect(ai.transcribe).not.toHaveBeenCalled()
  })

  it('resolveVideo uses client-provided transcript string', async () => {
    const { content, db, ai } = makeContent()
    const result = await content.resolveVideo('https://x.com/new.mp4', 'Full transcript here')
    expect(result.text).toBe('Full transcript here')
    expect(result.source_kind).toBe('provided')
    expect(ai.transcribe).not.toHaveBeenCalled()
    expect(db.rows).toHaveLength(1)
  })

  it('resolveVideo uses client-provided structured transcript', async () => {
    const { content } = makeContent()
    const transcript = [
      { start_s: 0, end_s: 10, audio: 'intro audio', visual: 'logo' },
      { start_s: 10, end_s: 20, audio: 'pricing', visual: 'chart' },
    ]
    const result = await content.resolveVideo('https://x.com/new.mp4', transcript)
    expect(result.segments).toEqual(transcript)
    expect(result.text).toContain('intro audio')
    expect(result.text).toContain('pricing')
  })
})

describe('engagement.content.sliceVideo', () => {

  it('returns full text when no range given', async () => {
    const { content } = makeContent()
    const cached = {
      text: 'audio one. audio two.',
      segments: [
        { start_s: 0, end_s: 5, audio: 'audio one.', visual: null },
        { start_s: 5, end_s: 10, audio: 'audio two.', visual: null },
      ],
    }
    expect(content.sliceVideo(cached, null, null)).toBe('audio one. audio two.')
  })

  it('slices by time range, joining audio and visual', async () => {
    const { content } = makeContent()
    const cached = {
      text: 'unused',
      segments: [
        { start_s: 0, end_s: 5, audio: 'first', visual: 'shot of logo' },
        { start_s: 5, end_s: 10, audio: 'second', visual: 'shot of chart' },
        { start_s: 10, end_s: 15, audio: 'third', visual: null },
      ],
    }
    const sliced = content.sliceVideo(cached, 4, 9)
    expect(sliced).toContain('first')
    expect(sliced).toContain('shot of logo')
    expect(sliced).toContain('second')
    expect(sliced).not.toContain('third')
  })

  it('falls back to content.text when no segments', async () => {
    const { content } = makeContent()
    const cached = { text: 'plain transcript', segments: [] }
    expect(content.sliceVideo(cached, 0, 100)).toBe('plain transcript')
  })

  it('returns empty when no segments and no text', async () => {
    const { content } = makeContent()
    expect(content.sliceVideo({ segments: [] }, 0, 5)).toBe('')
  })

  it('accepts intervals[] and unions matching segments', async () => {
    const { content } = makeContent()
    const cached = {
      text: 'unused',
      segments: [
        { start_s: 0, end_s: 5, audio: 'first', visual: null },
        { start_s: 5, end_s: 10, audio: 'second', visual: null },
        { start_s: 10, end_s: 15, audio: 'third', visual: null },
        { start_s: 15, end_s: 20, audio: 'fourth', visual: null },
      ],
    }
    const intervals = [
      { start_s: 0, end_s: 4 },     // overlaps segment 0 only
      { start_s: 12, end_s: 18 },   // overlaps segments 2 and 3
    ]
    const sliced = content.sliceVideo(cached, intervals)
    expect(sliced).toContain('first')
    expect(sliced).not.toContain('second')
    expect(sliced).toContain('third')
    expect(sliced).toContain('fourth')
  })

  it('includes each segment at most once across overlapping intervals', async () => {
    const { content } = makeContent()
    const cached = {
      text: 'unused',
      segments: [
        { start_s: 0, end_s: 10, audio: 'a', visual: null },
        { start_s: 10, end_s: 20, audio: 'b', visual: null },
      ],
    }
    // Two intervals that both overlap segment 1 (10-20)
    const intervals = [
      { start_s: 5, end_s: 12 },
      { start_s: 15, end_s: 18 },
    ]
    const sliced = content.sliceVideo(cached, intervals)
    expect((sliced.match(/b/g) || []).length).toBe(1)
  })

  it('accepts a single-object interval (back-compat)', async () => {
    const { content } = makeContent()
    const cached = {
      text: 'unused',
      segments: [
        { start_s: 0, end_s: 5, audio: 'first', visual: null },
        { start_s: 5, end_s: 10, audio: 'second', visual: null },
      ],
    }
    const sliced = content.sliceVideo(cached, { start_s: 4, end_s: 6 })
    expect(sliced).toContain('first')
    expect(sliced).toContain('second')
  })

  it('still accepts legacy two-arg (startS, endS) form', async () => {
    const { content } = makeContent()
    const cached = {
      text: 'unused',
      segments: [
        { start_s: 0, end_s: 5, audio: 'a', visual: null },
        { start_s: 5, end_s: 10, audio: 'b', visual: null },
      ],
    }
    const sliced = content.sliceVideo(cached, 0, 4)
    expect(sliced).toContain('a')
    expect(sliced).not.toContain('b')
  })
})

describe('engagement.content.invalidate', () => {
  it('deletes the cached row by url', async () => {
    const { content, db } = makeContent()
    db.rows.push({ url: 'https://x.com/p.jpg', kind: 'image', text: 'old' })
    db.rows.push({ url: 'https://x.com/q.jpg', kind: 'image', text: 'other' })
    const deleted = await content.invalidate('https://x.com/p.jpg')
    expect(deleted).toBe(1)
    expect(db.rows).toHaveLength(1)
    expect(db.rows[0].url).toBe('https://x.com/q.jpg')
  })
})
