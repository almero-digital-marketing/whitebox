import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import createOrchestrator from '../src/orchestrator.js'

// Minimal stand-in tracker that records calls so we can assert on lifecycle.
function makeTracker() {
  const observed = []
  const unobserved = []
  return {
    started: 0, stopped: 0,
    observed, unobserved,
    start() { this.started++ },
    stop()  { this.stopped++ },
    observe(el)   { observed.push(el) },
    unobserve(el) { unobserved.push(el) },
  }
}

function makeEl(tag = 'div', attrs = {}) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  return el
}

describe('orchestrator (generic)', () => {
  beforeEach(() => { document.body.innerHTML = '' })
  afterEach(() => { document.body.innerHTML = '' })

  it('requires a tracker and a find function', () => {
    expect(() => createOrchestrator({ tracker: makeTracker() })).toThrow(/find/)
    expect(() => createOrchestrator({ find: () => [] })).toThrow(/tracker/)
  })

  it('initial scan observes every element returned by find()', () => {
    const a = makeEl(); const b = makeEl()
    document.body.append(a, b)
    const tracker = makeTracker()
    const orch = createOrchestrator({
      tracker,
      find: (root) => [...root.querySelectorAll('div')],
    })
    orch.start()
    expect(tracker.observed).toEqual([a, b])
    expect(tracker.started).toBe(1)
    orch.stop()
    expect(tracker.stopped).toBe(1)
  })

  it('dedupes — observing the same element twice is a no-op', () => {
    const el = makeEl()
    document.body.append(el)
    const tracker = makeTracker()
    const orch = createOrchestrator({
      tracker,
      // find() returns the same element twice on purpose
      find: () => [el, el],
    })
    orch.start()
    expect(tracker.observed).toEqual([el])  // only once
    orch.stop()
  })

  it('calls match() to decide whether a mutation-added node is tracked', async () => {
    const tracker = makeTracker()
    const orch = createOrchestrator({
      tracker,
      find: (root) => [...root.querySelectorAll('[data-tracked]')],
      match: (el) => el.hasAttribute?.('data-tracked'),
    })
    orch.start()
    const yes = makeEl('div', { 'data-tracked': '' })
    const no  = makeEl('div')
    document.body.append(yes, no)
    // Wait for MutationObserver to flush
    await new Promise(r => setTimeout(r, 0))
    expect(tracker.observed).toContain(yes)
    expect(tracker.observed).not.toContain(no)
    orch.stop()
  })

  it('unobserves removed elements', async () => {
    const tracker = makeTracker()
    const el = makeEl()
    document.body.append(el)
    const orch = createOrchestrator({
      tracker,
      find: (root) => [...root.querySelectorAll('div')],
    })
    orch.start()
    el.remove()
    await new Promise(r => setTimeout(r, 0))
    expect(tracker.unobserved).toContain(el)
    orch.stop()
  })

  it('start() / stop() are idempotent', () => {
    const tracker = makeTracker()
    const orch = createOrchestrator({ tracker, find: () => [] })
    orch.start(); orch.start()
    expect(tracker.started).toBe(1)
    orch.stop(); orch.stop()
    expect(tracker.stopped).toBe(1)
  })

  it('re-scans on history.pushState (SPA navigation)', async () => {
    const tracker = makeTracker()
    const orch = createOrchestrator({
      tracker,
      find: (root) => [...root.querySelectorAll('div')],
    })
    orch.start()
    const initialCount = tracker.observed.length
    // Now add an element and trigger pushState — orchestrator should re-scan
    document.body.append(makeEl())
    history.pushState({}, '', '/new-route')
    await new Promise(r => setTimeout(r, 5))   // setTimeout(scan, 0) inside the hook
    expect(tracker.observed.length).toBeGreaterThan(initialCount)
    orch.stop()
    history.replaceState({}, '', '/')          // reset
  })
})
