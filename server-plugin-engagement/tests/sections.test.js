import { describe, it, expect, vi } from 'vitest'
import * as sections from '../src/sections.js'

// Re-init the module singleton with fresh deps per test, return the namespace
// so existing `sections.consume()` call sites are unchanged.
function makeSections() {
  const awareness = { record: vi.fn(async () => ({ id: 1 })) }
  const logger = { warn: vi.fn(), error: vi.fn() }
  sections.init({ awareness, logger })
  return { sections, awareness, logger }
}

describe('engagement.sections.consume', () => {

  it('records an exposure with channel=web, direction=exposure, source=section', async () => {
    const { sections, awareness } = makeSections()
    await sections.consume(
      { passportId: 'p1', sessionId: 7 },
      { id: 'pricing', url: 'https://x.com/pricing', text: 'Our Pro tier costs $9/mo', dwell_ms: 12000 }
    )
    expect(awareness.record).toHaveBeenCalledWith(expect.objectContaining({
      passport_id: 'p1',
      session_id: 7,
      channel: 'web',
      direction: 'exposure',
      source: 'section',
      content_id: 'pricing',
      content_url: 'https://x.com/pricing',
      text: 'Our Pro tier costs $9/mo',
      dwell_ms: 12000,
    }))
  })

  it('uses url as content_id when id missing', async () => {
    const { sections, awareness } = makeSections()
    await sections.consume(
      { passportId: 'p1', sessionId: null },
      { url: 'https://x.com/home', text: 'Welcome to home' }
    )
    expect(awareness.record).toHaveBeenCalledWith(expect.objectContaining({
      content_id: 'https://x.com/home',
    }))
  })

  it('does nothing when text is missing', async () => {
    const { sections, awareness } = makeSections()
    await sections.consume({ passportId: 'p1', sessionId: null }, { url: 'https://x.com/' })
    expect(awareness.record).not.toHaveBeenCalled()
  })

  it('does nothing for empty message', async () => {
    const { sections, awareness } = makeSections()
    await sections.consume({ passportId: 'p1', sessionId: null }, null)
    expect(awareness.record).not.toHaveBeenCalled()
  })

  it('swallows awareness errors and logs', async () => {
    const awareness = { record: vi.fn(async () => { throw new Error('db down') }) }
    const logger = { warn: vi.fn(), error: vi.fn() }
    sections.init({ awareness, logger })
    await sections.consume({ passportId: 'p1', sessionId: null }, { text: 'hi' })
    expect(logger.warn).toHaveBeenCalled()
  })
})
