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
