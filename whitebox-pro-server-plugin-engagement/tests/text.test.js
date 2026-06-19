import { describe, it, expect, vi } from 'vitest'
import * as text from '../src/text.js'

function makeText() {
  const awareness = { record: vi.fn(async () => ({ id: 1 })) }
  const logger = { warn: vi.fn(), error: vi.fn() }
  text.init({ awareness, logger })
  return { text, awareness, logger }
}

describe('engagement.text.readDepth', () => {
  it('scores a short heading far below a full paragraph', () => {
    const heading = text.readDepth({ length_chars: 18 })      // ~"Teeth Whitening" → 3-4 words
    const paragraph = text.readDepth({ length_chars: 520 })   // ~100 words
    expect(heading.depth).toBe('glance')
    expect(paragraph.depth).toBe('deep')
    expect(heading.engagement).toBeLessThan(0.15)
    expect(paragraph.engagement).toBe(1)
    expect(heading.engagement).toBeLessThan(paragraph.engagement)
  })

  it('halves a partial (unfinished) read', () => {
    const full = text.readDepth({ length_chars: 200, partial: false })    // 40 words → 0.5
    const partial = text.readDepth({ length_chars: 200, partial: true })  // 20 words → 0.25
    expect(full.engagement).toBe(0.5)
    expect(partial.engagement).toBe(0.25)
  })

  it('never returns zero (floor) and never exceeds 1 (ceiling)', () => {
    expect(text.readDepth({ length_chars: 1 }).engagement).toBeGreaterThan(0)
    expect(text.readDepth({ length_chars: 5000 }).engagement).toBe(1)
  })
})

describe('engagement.text.consume', () => {
  it('records the engagement weight + depth in meta', async () => {
    const { text, awareness } = makeText()
    await text.consume(
      { passportId: 'p1', sessionId: 7 },
      { id: 'imp-1', text: 'Dental implants replace a missing tooth with a titanium post and a natural-looking crown, placed in-house.', length_chars: 105, ms_spent: 9000, kind: 'paragraph' }
    )
    const arg = awareness.record.mock.calls[0][0]
    expect(arg).toMatchObject({ channel: 'web', direction: 'exposure', source: 'text', content_id: 'imp-1', dwell_ms: 9000 })
    expect(arg.meta.engagement).toBeGreaterThan(0)
    expect(arg.meta.engagement).toBeLessThanOrEqual(1)
    expect(['glance', 'read', 'deep']).toContain(arg.meta.depth)
  })

  it('weights a heading read below a paragraph read', async () => {
    const { text, awareness } = makeText()
    await text.consume({ passportId: 'p1' }, { id: 'h', text: 'Implants', length_chars: 8, kind: 'heading' })
    await text.consume({ passportId: 'p1' }, { id: 'p', text: 'x'.repeat(500), length_chars: 500, kind: 'paragraph' })
    const headingMeta = awareness.record.mock.calls[0][0].meta
    const paraMeta = awareness.record.mock.calls[1][0].meta
    expect(headingMeta.engagement).toBeLessThan(paraMeta.engagement)
    expect(headingMeta.depth).toBe('glance')
  })

  it('does nothing when text is missing', async () => {
    const { text, awareness } = makeText()
    await text.consume({ passportId: 'p1' }, { id: 'x' })
    expect(awareness.record).not.toHaveBeenCalled()
  })
})
