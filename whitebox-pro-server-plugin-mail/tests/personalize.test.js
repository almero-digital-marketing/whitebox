import { describe, it, expect, vi } from 'vitest'
import { personalizeLinks } from '../src/personalize.js'

const shortUrl = 'https://go.x/abc'

describe('personalizeLinks', () => {
  it('rewrites a marked link, strips data-wb-* attrs, preserves other attributes', async () => {
    const createLink = vi.fn(async () => ({ short_url: shortUrl }))
    const html = `<p><a href="https://clinic.com/x?ref=h" class="btn" data-wb-shorten data-wb-utm-content="hero">Book</a></p>`
    const out = await personalizeLinks(html, { createLink, passportId: 'P1' })
    expect(out).toBe(`<p><a href="https://go.x/abc" class="btn">Book</a></p>`)
    expect(createLink).toHaveBeenCalledWith({ url: 'https://clinic.com/x?ref=h', passport_id: 'P1', utm: { content: 'hero' } })
  })

  it('merges send-level utm with per-link overrides (link wins)', async () => {
    const createLink = vi.fn(async () => ({ short_url: shortUrl }))
    const html = `<a href="https://c.com/a" data-wb-shorten data-wb-utm-campaign="spring" data-wb-utm-source="link">x</a>`
    await personalizeLinks(html, { createLink, passportId: 'P1', utm: { source: 'email', medium: 'mail' } })
    expect(createLink.mock.calls[0][0].utm).toEqual({ source: 'link', medium: 'mail', campaign: 'spring' })
  })

  it('leaves non-marked links untouched', async () => {
    const createLink = vi.fn()
    const html = `<a href="https://c.com/a">x</a>`
    expect(await personalizeLinks(html, { createLink, passportId: 'P1' })).toBe(html)
    expect(createLink).not.toHaveBeenCalled()
  })

  it('returns html unchanged when there is no passport', async () => {
    const createLink = vi.fn()
    const html = `<a href="https://c.com/a" data-wb-shorten>x</a>`
    expect(await personalizeLinks(html, { createLink, passportId: null })).toBe(html)
    expect(createLink).not.toHaveBeenCalled()
  })

  it('keeps the original href when createLink throws', async () => {
    const createLink = vi.fn(async () => { throw new Error('shortener down') })
    const onError = vi.fn()
    const html = `<a href="https://c.com/a" data-wb-shorten>x</a>`
    const out = await personalizeLinks(html, { createLink, passportId: 'P1', onError })
    expect(out).toBe(`<a href="https://c.com/a">x</a>`)   // marker stripped, href preserved
    expect(onError).toHaveBeenCalled()
  })

  it('only shortens absolute http(s) links', async () => {
    const createLink = vi.fn(async () => ({ short_url: shortUrl }))
    const html = `<a href="/relative" data-wb-shorten>x</a> <a href="mailto:a@b.com" data-wb-shorten>y</a>`
    const out = await personalizeLinks(html, { createLink, passportId: 'P1' })
    expect(createLink).not.toHaveBeenCalled()
    expect(out).toBe(html)
  })

  it('handles single-quoted href', async () => {
    const createLink = vi.fn(async () => ({ short_url: shortUrl }))
    const html = `<a href='https://c.com/a' data-wb-shorten>x</a>`
    expect(await personalizeLinks(html, { createLink, passportId: 'P1' })).toBe(`<a href='https://go.x/abc'>x</a>`)
  })

  it('passes existing query params through and decodes &amp; before shortening', async () => {
    const createLink = vi.fn(async () => ({ short_url: shortUrl }))
    const html = `<a href="https://c.com/p?a=1&amp;b=2" data-wb-shorten>x</a>`
    await personalizeLinks(html, { createLink, passportId: 'P1' })
    // the shortener receives a real URL (entities decoded), so it parses both params
    expect(createLink.mock.calls[0][0].url).toBe('https://c.com/p?a=1&b=2')
  })

  it('reuses one createLink for identical marked tags', async () => {
    const createLink = vi.fn(async () => ({ short_url: shortUrl }))
    const html = `<a href="https://c.com/a" data-wb-shorten>1</a> … <a href="https://c.com/a" data-wb-shorten>2</a>`
    const out = await personalizeLinks(html, { createLink, passportId: 'P1' })
    expect(createLink).toHaveBeenCalledTimes(1)
    expect(out).toBe(`<a href="https://go.x/abc">1</a> … <a href="https://go.x/abc">2</a>`)
  })
})
