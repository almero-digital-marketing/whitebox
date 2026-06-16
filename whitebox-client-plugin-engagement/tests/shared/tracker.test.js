import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import createTracker from '../../src/tracker.js'

class FakeIO {
  static last = null
  constructor(cb, options) {
    this.cb = cb
    this.options = options
    this.observed = new Set()
    FakeIO.last = this
  }
  observe(el) { this.observed.add(el) }
  unobserve(el) { this.observed.delete(el) }
  disconnect() { this.observed.clear() }
  trigger(el, ratio) {
    this.cb([{ target: el, isIntersecting: ratio > 0, intersectionRatio: ratio }])
  }
}

function el(html = '<p>Some content here.</p>') {
  document.body.innerHTML = html
  return document.body.firstElementChild
}

function makeTracker({
  gates = [{ isOpen: () => true }],
  requiredMs = () => 50,
  buildPayload = (el, s) => ({ id: s.id, text: el.textContent, ms_spent: s.ms_spent, partial: s.partial }),
  onRead,
  options = { tickMs: 20, minPartialRatio: 0.5 },
} = {}) {
  return createTracker({ gates, requiredMs, buildPayload, onRead, options })
}

describe('tracker state machine', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    globalThis.IntersectionObserver = FakeIO
  })

  afterEach(() => {
    delete globalThis.IntersectionObserver
  })

  it('requires requiredMs and buildPayload', () => {
    expect(() => createTracker({})).toThrow(/requiredMs/)
    expect(() => createTracker({ requiredMs: () => 1 })).toThrow(/buildPayload/)
  })

  it('fires read event when required time elapses with all gates open', async () => {
    const onRead = vi.fn()
    const tracker = makeTracker({ onRead })
    tracker.start()

    const e = el()
    tracker.observe(e)
    FakeIO.last.trigger(e, 1.0)
    await new Promise(r => setTimeout(r, 120))

    expect(onRead).toHaveBeenCalledTimes(1)
    expect(onRead.mock.calls[0][0]).toMatchObject({
      text: 'Some content here.',
      partial: false,
    })

    tracker.stop()
  })

  it('does not fire when a gate is closed', async () => {
    const onRead = vi.fn()
    const tracker = makeTracker({
      gates: [{ isOpen: () => false }],
      onRead,
    })
    tracker.start()
    const e = el()
    tracker.observe(e)
    FakeIO.last.trigger(e, 1.0)
    await new Promise(r => setTimeout(r, 120))
    expect(onRead).not.toHaveBeenCalled()
    tracker.stop()
  })

  it('fires only when ALL gates are open', async () => {
    const onRead = vi.fn()
    let secondGate = false
    const tracker = makeTracker({
      gates: [
        { isOpen: () => true },
        { isOpen: () => secondGate },
      ],
      onRead,
    })
    tracker.start()
    const e = el()
    tracker.observe(e)
    FakeIO.last.trigger(e, 1.0)
    await new Promise(r => setTimeout(r, 120))
    expect(onRead).not.toHaveBeenCalled()  // second gate closed

    secondGate = true
    FakeIO.last.trigger(e, 1.0)
    await new Promise(r => setTimeout(r, 120))
    expect(onRead).toHaveBeenCalled()
    tracker.stop()
  })

  it('uses requiredMs(el) to size required time per element', async () => {
    const onRead = vi.fn()
    // First element needs 200ms, second needs 30ms
    const tracker = makeTracker({
      requiredMs: el => el.dataset.required ? Number(el.dataset.required) : 100,
      onRead,
    })
    tracker.start()
    document.body.innerHTML = `<p data-required="200">long</p><p data-required="30">short</p>`
    const [a, b] = document.body.children
    tracker.observe(a); tracker.observe(b)
    FakeIO.last.trigger(a, 1.0)
    FakeIO.last.trigger(b, 1.0)
    await new Promise(r => setTimeout(r, 80))   // long enough for b, short for a
    expect(onRead).toHaveBeenCalledTimes(1)
    expect(onRead.mock.calls[0][0].text).toBe('short')
    tracker.stop()
  })

  it('sequential mode: accumulates the topmost element first, then advances', async () => {
    const onRead = vi.fn()
    const tracker = makeTracker({
      requiredMs: () => 60,
      onRead,
      options: { tickMs: 20, minPartialRatio: 0.5, sequential: true },
    })
    tracker.start()
    document.body.innerHTML = `<p>first</p><p>second</p>`
    const [a, b] = document.body.children
    tracker.observe(a); tracker.observe(b)
    // Both visible at once — but only the topmost (first observed) should read.
    FakeIO.last.trigger(a, 1.0)
    FakeIO.last.trigger(b, 1.0)
    await new Promise(r => setTimeout(r, 100))
    expect(onRead).toHaveBeenCalledTimes(1)
    expect(onRead.mock.calls[0][0].text).toBe('first')
    // Focus advances to the second element, which then fires on its own.
    await new Promise(r => setTimeout(r, 100))
    expect(onRead).toHaveBeenCalledTimes(2)
    expect(onRead.mock.calls[1][0].text).toBe('second')
    tracker.stop()
  })

  it('sequential mode: each group has an independent focus', async () => {
    const onRead = vi.fn()
    const tracker = createTracker({
      gates: [{ isOpen: () => true }],
      requiredMs: () => 60,
      buildPayload: (el, s) => ({ text: el.textContent, partial: s.partial }),
      onRead,
      sequentialGroup: (el) => el.tagName,   // <p> queue independent of <h2> queue
      options: { tickMs: 20, minPartialRatio: 0.5, sequential: true },
    })
    tracker.start()
    document.body.innerHTML = `<p>p1</p><h2>h1</h2><p>p2</p><h2>h2</h2>`
    const els = [...document.body.children]
    els.forEach(e => tracker.observe(e))
    els.forEach(e => FakeIO.last.trigger(e, 1.0))
    // The first element of EACH group reads in parallel (p1 + the first h2).
    await new Promise(r => setTimeout(r, 100))
    expect(onRead).toHaveBeenCalledTimes(2)
    expect(onRead.mock.calls.map(c => c[0].text).sort()).toEqual(['h1', 'p1'])
    // Then each group advances to its next element.
    await new Promise(r => setTimeout(r, 100))
    expect(onRead).toHaveBeenCalledTimes(4)
    tracker.stop()
  })

  it('sequential mode: a deep block scrolled to the top releases focus', async () => {
    const onRead = vi.fn()
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })   // lineY = 200
    Object.defineProperty(window, 'scrollY', { value: 2000, configurable: true })      // scrolled deep into the page
    const tracker = createTracker({
      gates: [{ isOpen: () => true }],
      requiredMs: () => 10_000,   // long, so nothing fires — we inspect which block accumulates
      buildPayload: (el) => ({ text: el.textContent }),
      onRead,
      options: { tickMs: 20, sequential: true, readingLineRatio: 0.25 },
    })
    tracker.start()
    document.body.innerHTML = `<p>A</p><p>B</p>`
    const [a, b] = document.body.children
    // A is read and scrolled to the very top (middle above the line); both are deep
    // in the document (docTop = top + scrollY >> viewport), so not above-the-fold.
    a.getBoundingClientRect = () => ({ top: -250, bottom: 50, height: 300 })   // center -100 ≤ 200 → released
    b.getBoundingClientRect = () => ({ top: 150, bottom: 450, height: 300 })   // center 300 > 200 → focus
    tracker.observe(a); tracker.observe(b)
    FakeIO.last.trigger(a, 1.0); FakeIO.last.trigger(b, 1.0)
    await new Promise(r => setTimeout(r, 60))
    expect([...tracker._active]).toContain(b)       // focus on the block still on screen
    expect([...tracker._active]).not.toContain(a)   // A released, not blocking
    tracker.stop()
  })

  it('sequential mode: an above-the-fold block at the top still counts', async () => {
    const onRead = vi.fn()
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true })   // page at the very top
    const tracker = createTracker({
      gates: [{ isOpen: () => true }],
      requiredMs: () => 10_000,
      buildPayload: (el) => ({ text: el.textContent }),
      onRead,
      options: { tickMs: 20, sequential: true, readingLineRatio: 0.25 },
    })
    tracker.start()
    document.body.innerHTML = `<p>A</p><p>B</p>`
    const [a, b] = document.body.children
    // A sits in the top 25% but is first-screen content (docTop < viewport) → not released.
    a.getBoundingClientRect = () => ({ top: 20, bottom: 140, height: 120 })   // center 80 ≤ 200 but above-the-fold
    b.getBoundingClientRect = () => ({ top: 160, bottom: 280, height: 120 })
    tracker.observe(a); tracker.observe(b)
    FakeIO.last.trigger(a, 1.0); FakeIO.last.trigger(b, 1.0)
    await new Promise(r => setTimeout(r, 60))
    expect([...tracker._active]).toContain(a)       // above-the-fold block still tracked
    tracker.stop()
  })

  it('fires at most once per element', async () => {
    const onRead = vi.fn()
    const tracker = makeTracker({ onRead })
    tracker.start()
    const e = el()
    tracker.observe(e)
    FakeIO.last.trigger(e, 1.0)
    await new Promise(r => setTimeout(r, 120))
    FakeIO.last.trigger(e, 1.0)
    await new Promise(r => setTimeout(r, 120))
    expect(onRead).toHaveBeenCalledTimes(1)
    tracker.stop()
  })

  it('emits partial event on unobserve if past minPartialRatio', async () => {
    const onRead = vi.fn()
    const tracker = makeTracker({
      requiredMs: () => 200,
      onRead,
      options: { tickMs: 20, minPartialRatio: 0.4 },
    })
    tracker.start()
    const e = el()
    tracker.observe(e)
    FakeIO.last.trigger(e, 1.0)
    await new Promise(r => setTimeout(r, 120))   // ≈60% of required
    tracker.unobserve(e)
    expect(onRead).toHaveBeenCalledTimes(1)
    expect(onRead.mock.calls[0][0].partial).toBe(true)
    tracker.stop()
  })

  it('does not emit partial event if below minPartialRatio', async () => {
    const onRead = vi.fn()
    const tracker = makeTracker({
      requiredMs: () => 200,
      onRead,
      options: { tickMs: 20, minPartialRatio: 0.8 },
    })
    tracker.start()
    const e = el()
    tracker.observe(e)
    FakeIO.last.trigger(e, 1.0)
    await new Promise(r => setTimeout(r, 50))   // ≈25%
    tracker.unobserve(e)
    expect(onRead).not.toHaveBeenCalled()
    tracker.stop()
  })

  it('payload via buildPayload receives state fields', async () => {
    const onRead = vi.fn()
    const tracker = makeTracker({
      buildPayload: (el, s) => ({
        custom: 'shape',
        ms: s.ms_spent,
        url: s.url,
        partial: s.partial,
      }),
      onRead,
    })
    tracker.start()
    const e = el()
    tracker.observe(e)
    FakeIO.last.trigger(e, 1.0)
    await new Promise(r => setTimeout(r, 120))
    expect(onRead).toHaveBeenCalledWith(expect.objectContaining({ custom: 'shape', partial: false }))
    tracker.stop()
  })
})
