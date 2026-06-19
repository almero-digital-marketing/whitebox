import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import createImage from '../../src/image.js'

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
  trigger(el, ratio) {
    this.cb([{ target: el, isIntersecting: ratio > 0, intersectionRatio: ratio }])
  }
  static latest() { return FakeIO.instances[FakeIO.instances.length - 1] }
}

describe('image engagement (opt-in only)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    FakeIO.instances = []
    globalThis.IntersectionObserver = FakeIO
  })
  afterEach(() => {
    delete globalThis.IntersectionObserver
  })

  it('observes only [data-wb-image] elements on initial scan', () => {
    document.body.innerHTML = `
      <img src="/a.png">
      <img src="/b.png" data-wb-image>
      <img src="/c.png" data-wb-image="hero">
      <div data-wb-image><img src="/d.png"></div>
    `
    const t = createImage({ onRead: vi.fn(), options: { tickMs: 50 } })
    t.start()
    expect(FakeIO.latest().observed.size).toBe(3)
    t.stop()
  })

  it('fires an engagement event after requiredMs in viewport', async () => {
    document.body.innerHTML = `<img src="https://x/a.png" alt="Cat photo" data-wb-image>`
    const onRead = vi.fn()
    const t = createImage({
      onRead,
      options: { requiredMs: 30, tickMs: 10 },
    })
    t.start()

    const el = document.body.firstElementChild
    FakeIO.latest().trigger(el, 1.0)
    await new Promise(r => setTimeout(r, 80))

    expect(onRead).toHaveBeenCalledTimes(1)
    expect(onRead.mock.calls[0][0]).toMatchObject({
      kind: 'image',
      src: 'https://x/a.png',
      alt: 'Cat photo',
      partial: false,
    })
    t.stop()
  })

  it('does not require scroll velocity to be stable (unlike text)', async () => {
    // For text, fast scrolling closes the velocity gate and reading time
    // doesn't accumulate. For images we deliberately skip that gate — the
    // user can scroll past slowly and still register engagement.
    document.body.innerHTML = `<img src="/x.png" data-wb-image>`
    const onRead = vi.fn()
    const t = createImage({ onRead, options: { requiredMs: 30, tickMs: 10 } })
    t.start()

    // Simulate scrolling activity — should NOT prevent image from firing
    window.dispatchEvent(new Event('scroll'))

    const el = document.body.firstElementChild
    FakeIO.latest().trigger(el, 1.0)
    await new Promise(r => setTimeout(r, 80))
    expect(onRead).toHaveBeenCalled()
    t.stop()
  })

  it('uses data-wb-image value as stable id', async () => {
    document.body.innerHTML = `<img src="/x.png" data-wb-image="hero-banner">`
    const onRead = vi.fn()
    const t = createImage({ onRead, options: { requiredMs: 30, tickMs: 10 } })
    t.start()
    const el = document.body.firstElementChild
    FakeIO.latest().trigger(el, 1.0)
    await new Promise(r => setTimeout(r, 80))
    expect(onRead.mock.calls[0][0].id).toBe('hero-banner')
    t.stop()
  })

  it('falls back to src-hashed id', async () => {
    document.body.innerHTML = `<img src="https://x/no-id.png" data-wb-image>`
    const onRead = vi.fn()
    const t = createImage({ onRead, options: { requiredMs: 30, tickMs: 10 } })
    t.start()
    const el = document.body.firstElementChild
    FakeIO.latest().trigger(el, 1.0)
    await new Promise(r => setTimeout(r, 80))
    expect(onRead.mock.calls[0][0].id).toMatch(/^wb:/)
    t.stop()
  })

  it('extracts src/alt from child <img> when opt-in is on a wrapper', async () => {
    document.body.innerHTML = `<figure data-wb-image="hero"><img src="https://x/hero.png" alt="Hero shot"></figure>`
    const onRead = vi.fn()
    const t = createImage({ onRead, options: { requiredMs: 30, tickMs: 10 } })
    t.start()
    const el = document.body.firstElementChild
    FakeIO.latest().trigger(el, 1.0)
    await new Promise(r => setTimeout(r, 80))
    expect(onRead.mock.calls[0][0]).toMatchObject({
      src: 'https://x/hero.png',
      alt: 'Hero shot',
    })
    t.stop()
  })

  it('honors data-wb-noimage on ancestor', () => {
    document.body.innerHTML = `
      <img src="/a.png" data-wb-image>
      <div data-wb-noimage><img src="/b.png" data-wb-image></div>
    `
    const t = createImage({ onRead: vi.fn(), options: { tickMs: 50 } })
    t.start()
    expect(FakeIO.latest().observed.size).toBe(1)
    t.stop()
  })

  it('rescans on SPA navigation via history.pushState', async () => {
    const t = createImage({ onRead: vi.fn(), options: { tickMs: 50 } })
    t.start()
    const initial = FakeIO.latest().observed.size

    document.body.innerHTML = `<img src="/new.png" data-wb-image>`
    history.pushState({}, '', '/new-page')
    await new Promise(r => setTimeout(r, 30))

    expect(FakeIO.latest().observed.size).toBeGreaterThan(initial)
    t.stop()
  })
})
