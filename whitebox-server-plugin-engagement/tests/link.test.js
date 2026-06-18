import { describe, it, expect, vi } from 'vitest'
import * as links from '../src/link.js'

function makeLinks() {
  const awareness = { record: vi.fn(async () => ({ id: 1 })) }
  const logger = { warn: vi.fn(), error: vi.fn() }
  links.init({ awareness, logger })
  return { links, awareness, logger }
}

describe('engagement.link.consume', () => {
  it('records a click as a web EXPRESSION (active intent) with full engagement', async () => {
    const { links, awareness } = makeLinks()
    await links.consume(
      { passportId: 'p1', sessionId: 7 },
      { id: 'imp', text: 'dental implant pricing and financing', href: 'https://x.com/implants' }
    )
    expect(awareness.record).toHaveBeenCalledWith(expect.objectContaining({
      passport_id: 'p1',
      session_id: 7,
      channel: 'web',
      direction: 'expression',
      source: 'link',
      content_id: 'imp',
      content_url: 'https://x.com/implants',
      text: 'dental implant pricing and financing',
    }))
    const meta = awareness.record.mock.calls[0][0].meta
    expect(meta).toMatchObject({ kind: 'link', engagement: 1, depth: 'click' })
  })

  it('does nothing without text', async () => {
    const { links, awareness } = makeLinks()
    await links.consume({ passportId: 'p1' }, { href: 'https://x.com' })
    expect(awareness.record).not.toHaveBeenCalled()
  })

  it('swallows awareness errors and logs', async () => {
    const awareness = { record: vi.fn(async () => { throw new Error('db down') }) }
    const logger = { warn: vi.fn(), error: vi.fn() }
    links.init({ awareness, logger })
    await links.consume({ passportId: 'p1' }, { text: 'Learn more' })
    expect(logger.warn).toHaveBeenCalled()
  })
})
