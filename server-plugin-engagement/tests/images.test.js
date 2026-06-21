import { describe, it, expect, vi } from 'vitest'
import * as images from '../src/images.js'
import * as content from '../src/content.js'

// images depends on the content module (namespace import). Mock it so we can
// assert the calls images makes into it.
vi.mock('../src/content.js', () => ({
  resolveImage: vi.fn(),
}))

// Re-init the module singleton with fresh deps per test, return the namespace
// so existing `images.consume()` call sites are unchanged.
function makeImages({ resolved } = {}) {
  const awareness = { record: vi.fn(async () => ({ id: 1 })) }
  const logger = { warn: vi.fn(), error: vi.fn() }
  content.resolveImage.mockReset()
  content.resolveImage.mockResolvedValue(resolved ?? { url: 'u', kind: 'image', text: 'A diagram showing X' })
  images.init({ awareness, logger })
  return { images, awareness, content, logger }
}

describe('engagement.images.consume', () => {

  it('resolves image then records description as exposure text', async () => {
    const { images, awareness, content } = makeImages()
    await images.consume(
      { passportId: 'p1', sessionId: 9 },
      { url: 'https://cdn.x/hero.png', dwell_ms: 4000 }
    )
    expect(content.resolveImage).toHaveBeenCalledWith('https://cdn.x/hero.png', undefined)
    expect(awareness.record).toHaveBeenCalledWith(expect.objectContaining({
      passport_id: 'p1',
      session_id: 9,
      channel: 'web',
      direction: 'exposure',
      source: 'image',
      content_id: 'https://cdn.x/hero.png',
      text: 'A diagram showing X',
      dwell_ms: 4000,
    }))
  })

  it('passes client-provided description to resolver', async () => {
    const { images, content } = makeImages()
    await images.consume(
      { passportId: 'p1', sessionId: null },
      { url: 'https://cdn.x/p.png', description: 'Pricing chart' }
    )
    expect(content.resolveImage).toHaveBeenCalledWith('https://cdn.x/p.png', 'Pricing chart')
  })

  it('skips when url missing', async () => {
    const { images, awareness, content } = makeImages()
    await images.consume({ passportId: 'p1', sessionId: null }, {})
    expect(content.resolveImage).not.toHaveBeenCalled()
    expect(awareness.record).not.toHaveBeenCalled()
  })

  it('skips when resolver returns empty text', async () => {
    const { images, awareness } = makeImages({ resolved: { url: 'u', kind: 'image', text: '' } })
    await images.consume({ passportId: 'p1', sessionId: null }, { url: 'https://cdn.x/p.png' })
    expect(awareness.record).not.toHaveBeenCalled()
  })

  it('swallows resolver errors and logs', async () => {
    const awareness = { record: vi.fn() }
    const logger = { warn: vi.fn(), error: vi.fn() }
    content.resolveImage.mockReset()
    content.resolveImage.mockRejectedValue(new Error('vision down'))
    images.init({ awareness, logger })
    await images.consume({ passportId: 'p1', sessionId: null }, { url: 'https://cdn.x/p.png' })
    expect(logger.warn).toHaveBeenCalled()
    expect(awareness.record).not.toHaveBeenCalled()
  })
})
