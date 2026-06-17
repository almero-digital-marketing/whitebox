import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import createPhoneTracker from '../src/phone.js'

class FakeIO {
  static instances = []
  constructor(cb, opts) {
    this.cb = cb
    this.opts = opts
    this.observed = new Set()
    FakeIO.instances.push(this)
  }
  observe(el) { this.observed.add(el) }
  unobserve(el) { this.observed.delete(el) }
  disconnect() { this.observed.clear() }
  triggerIntersect(el, ratio) {
    this.cb([{ target: el, isIntersecting: ratio > 0, intersectionRatio: ratio }])
  }
  static latest() { return FakeIO.instances[FakeIO.instances.length - 1] }
}

// One bus that plays both `transport` (send) and `emitter` (on/off/emit) —
// matching the real client, where the transport forwards incoming socket events
// onto the emitter. trigger() is an alias for an incoming server event.
function makeBus() {
  const handlers = new Map()
  const sent = [], emitted = []
  return {
    sent, emitted,
    isConnected: () => true,
    send: vi.fn((event, data) => { sent.push({ event, data }) }),
    on(event, fn) { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(fn); return () => handlers.get(event)?.delete(fn) },
    off(event, fn) { handlers.get(event)?.delete(fn) },
    emit: vi.fn(function (event, data) { emitted.push({ event, data }); handlers.get(event)?.forEach(fn => fn(data)) }),
    trigger(event, data) { this.emit(event, data) },
  }
}

function phoneLink({ tag = 'sales', tel = '+15551111111', text } = {}) {
  const a = document.createElement('a')
  a.setAttribute('data-wb-phone', tag)
  a.setAttribute('href', `tel:${tel}`)
  a.textContent = text ?? tel
  document.body.appendChild(a)
  return a
}

describe('voip phone tracker', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    FakeIO.instances = []
    globalThis.IntersectionObserver = FakeIO
  })
  afterEach(() => {
    delete globalThis.IntersectionObserver
    vi.useRealTimers()
  })

  it('emits voip.pick on first visible element for a tag', () => {
    const bus = makeBus()
    const tracker = createPhoneTracker({ transport: bus, emitter: bus, options: { idleAfterMs: Infinity } })
    tracker.start()
    const el = phoneLink({ tag: 'sales' })
    tracker.observe(el)
    FakeIO.latest().triggerIntersect(el, 1.0)

    expect(bus.send).toHaveBeenCalledWith('voip.pick', { tag: 'sales' })
    tracker.stop()
  })

  it('swaps DOM when voip.number arrives', () => {
    const bus = makeBus()
    const tracker = createPhoneTracker({ transport: bus, emitter: bus, options: { idleAfterMs: Infinity } })
    tracker.start()
    const el = phoneLink({ tag: 'sales', tel: '+15551111111', text: '+1 555 111 1111' })
    tracker.observe(el)
    FakeIO.latest().triggerIntersect(el, 1.0)

    bus.trigger('voip.number', {
      tag: 'sales',
      number: '+15559998877',
      formatted: '+1 555 999 8877',
    })

    expect(el.getAttribute('href')).toBe('tel:+15559998877')
    expect(el.textContent).toBe('+1 555 999 8877')
    expect(el.getAttribute('data-wb-phone-assigned')).toBe('+15559998877')
    tracker.stop()
  })

  it('shares one number across multiple elements with the same tag', () => {
    const bus = makeBus()
    const tracker = createPhoneTracker({ transport: bus, emitter: bus, options: { idleAfterMs: Infinity } })
    tracker.start()
    const a = phoneLink({ tag: 'sales', tel: '+15551111111' })
    const b = phoneLink({ tag: 'sales', tel: '+15552222222' })
    tracker.observe(a)
    tracker.observe(b)
    FakeIO.latest().triggerIntersect(a, 1.0)

    // Only one voip.pick should fire
    expect(bus.send).toHaveBeenCalledTimes(1)

    bus.trigger('voip.number', { tag: 'sales', number: '+15559998877', formatted: '+1 555 999 8877' })

    expect(a.getAttribute('href')).toBe('tel:+15559998877')
    expect(b.getAttribute('href')).toBe('tel:+15559998877')
    tracker.stop()
  })

  it('emits voip.click and stays sticky on link click', () => {
    const bus = makeBus()
    const tracker = createPhoneTracker({ transport: bus, emitter: bus, options: { idleAfterMs: Infinity, releaseDelayMs: 50 } })
    tracker.start()
    const el = phoneLink({ tag: 'sales' })
    tracker.observe(el)
    FakeIO.latest().triggerIntersect(el, 1.0)
    bus.trigger('voip.number', { tag: 'sales', number: '+15559998877', formatted: '+1 555 999 8877' })

    el.dispatchEvent(new Event('click'))

    expect(bus.send).toHaveBeenCalledWith('voip.click', expect.objectContaining({
      tag: 'sales',
      number: '+15559998877',
    }))
    expect(bus.emitted.some(e => e.event === 'voip.click')).toBe(true)
    expect(tracker.current('sales')?.state).toBe('clicked')
    tracker.stop()
  })

  it('does NOT auto-release a clicked tag when element leaves viewport', async () => {
    const bus = makeBus()
    const tracker = createPhoneTracker({ transport: bus, emitter: bus, options: { idleAfterMs: Infinity, releaseDelayMs: 10 } })
    tracker.start()
    const el = phoneLink({ tag: 'sales' })
    tracker.observe(el)
    FakeIO.latest().triggerIntersect(el, 1.0)
    bus.trigger('voip.number', { tag: 'sales', number: '+15559998877', formatted: 'fmt' })
    el.dispatchEvent(new Event('click'))

    // Leave viewport
    FakeIO.latest().triggerIntersect(el, 0)
    await new Promise(r => setTimeout(r, 30))

    expect(bus.send).not.toHaveBeenCalledWith('voip.hang', expect.anything())
    expect(tracker.current('sales')?.state).toBe('clicked')
    tracker.stop()
  })

  it('releases on viewport leave after releaseDelayMs', async () => {
    const bus = makeBus()
    const tracker = createPhoneTracker({ transport: bus, emitter: bus, options: { idleAfterMs: Infinity, releaseDelayMs: 30 } })
    tracker.start()
    const el = phoneLink({ tag: 'sales', tel: '+15551111111', text: '+1 555 111 1111' })
    tracker.observe(el)
    FakeIO.latest().triggerIntersect(el, 1.0)
    bus.trigger('voip.number', { tag: 'sales', number: '+15559998877', formatted: '+1 555 999 8877' })

    FakeIO.latest().triggerIntersect(el, 0)
    await new Promise(r => setTimeout(r, 60))

    expect(bus.send).toHaveBeenCalledWith('voip.hang', { tag: 'sales' })
    // Original number restored
    expect(el.getAttribute('href')).toBe('tel:+15551111111')
    expect(el.textContent).toBe('+1 555 111 1111')
    tracker.stop()
  })

  it('releases all on tab hidden', () => {
    const bus = makeBus()
    const tracker = createPhoneTracker({ transport: bus, emitter: bus, options: { idleAfterMs: Infinity } })
    tracker.start()
    const el = phoneLink({ tag: 'sales' })
    tracker.observe(el)
    FakeIO.latest().triggerIntersect(el, 1.0)
    bus.trigger('voip.number', { tag: 'sales', number: '+15559998877', formatted: 'fmt' })

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))

    expect(bus.send).toHaveBeenCalledWith('voip.hang', { tag: 'sales' })
    expect(tracker.current('sales')).toBeNull()
    // restore
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    tracker.stop()
  })

  it('releases all on window blur', () => {
    const bus = makeBus()
    const tracker = createPhoneTracker({ transport: bus, emitter: bus, options: { idleAfterMs: Infinity } })
    tracker.start()
    const el = phoneLink({ tag: 'sales' })
    tracker.observe(el)
    FakeIO.latest().triggerIntersect(el, 1.0)
    bus.trigger('voip.number', { tag: 'sales', number: '+15559998877', formatted: 'fmt' })

    window.dispatchEvent(new Event('blur'))

    expect(bus.send).toHaveBeenCalledWith('voip.hang', { tag: 'sales' })
    tracker.stop()
  })

  it('releases after maxHoldMs without click', async () => {
    const bus = makeBus()
    const tracker = createPhoneTracker({ transport: bus, emitter: bus, options: { idleAfterMs: Infinity, maxHoldMs: 40, releaseDelayMs: 1000 } })
    tracker.start()
    const el = phoneLink({ tag: 'sales' })
    tracker.observe(el)
    FakeIO.latest().triggerIntersect(el, 1.0)
    bus.trigger('voip.number', { tag: 'sales', number: '+15559998877', formatted: 'fmt' })

    await new Promise(r => setTimeout(r, 80))

    expect(bus.send).toHaveBeenCalledWith('voip.hang', { tag: 'sales' })
    tracker.stop()
  })

  it('backs off after voip.unavailable response', async () => {
    const bus = makeBus()
    const tracker = createPhoneTracker({ transport: bus, emitter: bus, options: { idleAfterMs: Infinity, requestBackoffMs: 100 } })
    tracker.start()
    const el = phoneLink({ tag: 'sales' })
    tracker.observe(el)
    FakeIO.latest().triggerIntersect(el, 1.0)
    bus.trigger('voip.unavailable', { tag: 'sales' })

    // Subsequent visibility doesn't trigger another pick until backoff elapses
    FakeIO.latest().triggerIntersect(el, 0)
    FakeIO.latest().triggerIntersect(el, 1.0)
    expect(bus.send).toHaveBeenCalledTimes(1)  // only the initial pick
    tracker.stop()
  })

  it('voip.ring reaches app consumers via the emitter (no self-loop)', () => {
    const bus = makeBus()
    const tracker = createPhoneTracker({ transport: bus, emitter: bus, options: { idleAfterMs: Infinity } })
    tracker.start()
    const seen = []
    bus.on('voip.ring', (d) => seen.push(d))   // an app consumer hook
    bus.trigger('voip.ring', { tag: 'sales', caller: '+44...', number: '+15559998877' })
    expect(seen).toHaveLength(1)               // delivered once — not re-emitted into a loop
    tracker.stop()
  })

  it('releases all on pagehide via beacon', () => {
    const bus = makeBus()
    const http = { beacon: vi.fn() }
    const tracker = createPhoneTracker({ transport: bus, http, emitter: bus, options: { idleAfterMs: Infinity } })
    tracker.start()
    const el = phoneLink({ tag: 'sales' })
    tracker.observe(el)
    FakeIO.latest().triggerIntersect(el, 1.0)
    bus.trigger('voip.number', { tag: 'sales', number: '+15559998877', formatted: 'fmt' })

    window.dispatchEvent(new Event('pagehide'))

    expect(http.beacon).toHaveBeenCalledWith('/voip/hang', { tag: 'sales' })
    tracker.stop()
  })
})
