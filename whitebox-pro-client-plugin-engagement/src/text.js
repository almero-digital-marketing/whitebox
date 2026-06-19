// Text engagement: paragraphs + headings + any opt-in element.
// Builds a time-accumulating tracker with activity + velocity gates and a
// length-based required_ms, then hands it to the generic orchestrator.

import createOrchestrator from 'whitebox-pro-client/orchestrator'
import createTracker from './tracker.js'
import createActivity from 'whitebox-pro-client/activity'
import createVelocity from './velocity.js'
import createPointer from './pointer.js'
import {
  DEFAULT_TEXT_SELECTOR,
  DEFAULT_TEXT_EXCLUDE,
  DEFAULT_TEXT_ID_ATTR,
  buildScannerHooks,
} from './scanner.js'

const isCoarsePointer = () =>
  typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches

const HEADING_LEVEL = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 }

const DEFAULTS = {
  cps: 30,
  capRequiredMs: 30_000,
  minRequiredMs: 1500,
  minPartialRatio: 0.5,
  tickMs: 250,
  sequential: true,        // read top-to-bottom: only the topmost visible block accumulates
  readingLineRatio: 0.25,  // a block read & scrolled up releases focus once its middle passes above the top 25%
  endOfDocument: true,         // count end-of-document blocks that can't be scrolled up into the band
}

function classify(el) {
  const tag = el.tagName?.toLowerCase()
  if (HEADING_LEVEL[tag]) return { kind: 'heading', level: HEADING_LEVEL[tag] }
  return { kind: 'paragraph', level: null }
}

export default function createTextEngagements({ onRead, onProgress, options = {} } = {}) {
  const cfg = { ...DEFAULTS, ...options }
  const idAttribute = options.idAttribute ?? DEFAULT_TEXT_ID_ATTR

  function requiredMs(el) {
    const text = (el.textContent || '').trim()
    const raw = (text.length / cfg.cps) * 1000
    return Math.max(cfg.minRequiredMs, Math.min(cfg.capRequiredMs, raw))
  }

  function buildPayload(el, state) {
    const { kind, level } = classify(el)
    const text = (el.textContent || '').trim()
    return {
      id: state.id,
      kind,
      level,
      text,
      length_chars: text.length,
      ms_spent: state.ms_spent,
      url: state.url,
      partial: state.partial,
    }
  }

  // On touch devices the page is the only thing on screen, so input-idle isn't a
  // disengagement signal — visibility (app-switch / lock) is. Default the idle
  // gate off there; an explicit idleAfterMs still wins.
  const idleAfterMs = options.idleAfterMs !== undefined
    ? options.idleAfterMs
    : (isCoarsePointer() ? Infinity : undefined)
  const activity = createActivity({ idleAfterMs })
  const velocity = createVelocity({
    maxVelocity: options.scrollVelocityMax,   // fixed fallback / default
    quietMs: options.scrollQuietMs,
  })

  // Pointer attention (desktop): the paragraph the mouse rests on takes focus.
  // Inert on touch (no hover); disable with pointerAttention: false.
  const pointer = options.pointerAttention === false ? null : createPointer({
    dwellMs: options.pointerDwellMs,
    selector: options.selector ?? DEFAULT_TEXT_SELECTOR,
  })

  // Per-element scroll-velocity threshold, scaled by the element's font size —
  // big headings tolerate faster scrolling than body text, so you can scan a
  // heading while a paragraph at the same scroll speed waits for you to settle.
  //   scrollVelocityForFontSize(px) → max velocity   (arbitrary curve)
  //   scrollVelocityFactor          → linear: factor × px
  //   else scrollVelocityMax / default (fixed)
  const fontSizeCache = new WeakMap()
  function maxVelocityFor(el) {
    const curve = options.scrollVelocityForFontSize
    const factor = options.scrollVelocityFactor
    if (typeof curve !== 'function' && factor == null) return options.scrollVelocityMax
    let fs = fontSizeCache.get(el)
    if (fs === undefined) {
      fs = (typeof getComputedStyle === 'function' ? parseFloat(getComputedStyle(el).fontSize) : NaN) || 16
      fontSizeCache.set(el, fs)
    }
    return typeof curve === 'function' ? curve(fs) : factor * fs
  }

  const inner = createTracker({
    gates: [
      { isOpen: activity.isOpen },
      { isOpen: (el) => velocity.isStable(el ? maxVelocityFor(el) : undefined) },
    ],
    requiredMs,
    buildPayload,
    onRead,
    onProgress,
    // Headings and paragraphs read as independent top-to-bottom queues — a
    // heading doesn't block the paragraph under it (or vice versa).
    sequentialGroup: (el) => classify(el).kind,
    attendedElement: pointer ? pointer.attended : undefined,
    options: { ...cfg, idAttribute },
  })

  // Wrap tracker with gate attach/detach lifecycle so the orchestrator only
  // needs to call start/stop.
  const tracker = {
    observe: inner.observe,
    unobserve: inner.unobserve,
    start: () => { activity.attach(); velocity.attach(); pointer?.attach(); inner.start() },
    stop:  () => { inner.stop(); pointer?.detach(); velocity.detach(); activity.detach() },
  }

  const scannerOptions = {
    selector:        options.selector        ?? DEFAULT_TEXT_SELECTOR,
    excludeSelector: options.excludeSelector ?? DEFAULT_TEXT_EXCLUDE,
    idAttribute,
    minLength:       options.minLength       ?? 3,
  }
  return createOrchestrator({ tracker, ...buildScannerHooks(scannerOptions) })
}
