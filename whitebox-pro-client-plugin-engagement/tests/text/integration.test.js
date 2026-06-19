import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import createText from '../../src/text.js'

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

describe('text orchestrator (opt-in only)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    FakeIO.instances = []
    globalThis.IntersectionObserver = FakeIO
  })
  afterEach(() => {
    delete globalThis.IntersectionObserver
  })

  it('observes only elements with data-wb-text on initial scan', () => {
    document.body.innerHTML = `
      <h1>Untracked heading</h1>
      <h1 data-wb-text>Tracked heading</h1>
      <p>${'A'.repeat(200)}</p>
      <p data-wb-text>${'B'.repeat(120)}</p>
    `
    const onRead = vi.fn()
    const t = createText({ onRead, options: { tickMs: 50 } })
    t.start()
    expect(FakeIO.latest().observed.size).toBe(2)
    t.stop()
  })

  it('picks up new opt-in elements added via MutationObserver', async () => {
    const onRead = vi.fn()
    const t = createText({ onRead, options: { tickMs: 50 } })
    t.start()
    expect(FakeIO.latest().observed.size).toBe(0)

    const div = document.createElement('div')
    div.innerHTML = `
      <p>${'untracked'.repeat(20)}</p>
      <p data-wb-text>${'B'.repeat(120)}</p>
      <h2 data-wb-text>Heading</h2>
    `
    document.body.appendChild(div)

    await new Promise(r => setTimeout(r, 30))  // let MutationObserver flush
    expect(FakeIO.latest().observed.size).toBe(2)
    t.stop()
  })

  it('does not observe newly-added elements without data-wb-text', async () => {
    const onRead = vi.fn()
    const t = createText({ onRead, options: { tickMs: 50 } })
    t.start()

    document.body.innerHTML = `
      <p>${'C'.repeat(200)}</p>
      <h1>Headline</h1>
    `
    await new Promise(r => setTimeout(r, 30))
    expect(FakeIO.latest().observed.size).toBe(0)
    t.stop()
  })

  it('unobserves elements removed from the DOM', async () => {
    document.body.innerHTML = `<p data-wb-text>${'D'.repeat(120)}</p>`
    const onRead = vi.fn()
    const t = createText({ onRead, options: { tickMs: 50 } })
    t.start()
    expect(FakeIO.latest().observed.size).toBe(1)

    document.body.innerHTML = ''
    await new Promise(r => setTimeout(r, 30))
    expect(FakeIO.latest().observed.size).toBe(0)
    t.stop()
  })

  it('emits a read event when an observed element passes all gates', async () => {
    document.body.innerHTML = `<p data-wb-text>${'E'.repeat(40)}</p>`
    const onRead = vi.fn()
    const t = createText({
      onRead,
      options: {
        cps: 1000,
        tickMs: 20,
        minRequiredMs: 30,
        capRequiredMs: 100,
      },
    })
    t.start()

    const el = document.body.firstElementChild
    FakeIO.latest().trigger(el, 1.0)
    await new Promise(r => setTimeout(r, 150))
    expect(onRead).toHaveBeenCalled()
    expect(onRead.mock.calls[0][0]).toMatchObject({
      kind: 'paragraph',
      partial: false,
    })
    t.stop()
  })

  it('honors a custom selector passed through options', async () => {
    document.body.innerHTML = `
      <p data-wb-text>Default-selector content — ignored when overridden.</p>
      <p class="article-text">Custom-selector content.</p>
      <h2 class="article-text">Another custom match.</h2>
    `
    const onRead = vi.fn()
    const t = createText({ onRead, options: { tickMs: 50, selector: '.article-text' } })
    t.start()
    expect(FakeIO.latest().observed.size).toBe(2)
    t.stop()
  })

  it('rescans on history.pushState (SPA navigation)', async () => {
    const onRead = vi.fn()
    const t = createText({ onRead, options: { tickMs: 50 } })
    t.start()
    const initialObserved = FakeIO.latest().observed.size

    document.body.innerHTML = `<p data-wb-text>${'F'.repeat(120)}</p>`
    history.pushState({}, '', '/new-route')
    await new Promise(r => setTimeout(r, 30))

    expect(FakeIO.latest().observed.size).toBeGreaterThan(initialObserved)
    t.stop()
  })
})
