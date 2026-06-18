// Image engagement: an image is "engaged with" when it stays in the viewport
// for ≥ requiredMs (default 3000 ms). Scroll velocity is not a factor — the
// user can keep scrolling slowly and an image still counts as engaged.
//
// Opt-in via [data-wb-image] (default selector); customisable.

import createOrchestrator from 'whitebox-client/orchestrator'
import createTracker from './tracker.js'
import createActivity from 'whitebox-client/activity'
import {
  DEFAULT_IMAGE_SELECTOR,
  DEFAULT_IMAGE_EXCLUDE,
  DEFAULT_IMAGE_ID_ATTR,
  buildScannerHooks,
} from './scanner.js'

const DEFAULTS = {
  requiredMs: 3000,    // ≥3s in viewport, activity gate open → engaged
  tickMs: 250,
  minPartialRatio: 0.5,
  sequential: false,   // images are independent of one another (and of text) — track in parallel
}

function buildPayload(el, state) {
  const tag = el.tagName?.toLowerCase()
  let src = null
  let alt = null
  let width = null
  let height = null

  if (tag === 'img') {
    src = el.currentSrc || el.src || el.getAttribute('src') || null
    alt = el.alt || null
    width = el.naturalWidth || null
    height = el.naturalHeight || null
  } else {
    const childImg = el.querySelector?.('img')
    if (childImg) {
      src = childImg.currentSrc || childImg.src || childImg.getAttribute('src') || null
      alt = childImg.alt || null
      width = childImg.naturalWidth || null
      height = childImg.naturalHeight || null
    }
  }

  return {
    id: state.id,
    kind: 'image',
    src,
    alt,
    width,
    height,
    ms_spent: state.ms_spent,
    url: state.url,
    partial: state.partial,
  }
}

export default function createImageEngagements({ onRead, onProgress, options = {} } = {}) {
  const cfg = { ...DEFAULTS, ...options }
  const fixedRequiredMs = cfg.requiredMs
  const idAttribute = options.idAttribute ?? DEFAULT_IMAGE_ID_ATTR

  const activity = createActivity({ idleAfterMs: options.idleAfterMs })

  const inner = createTracker({
    gates: [{ isOpen: activity.isOpen }],
    requiredMs: () => fixedRequiredMs,
    buildPayload,
    onRead,
    onProgress,
    options: { ...cfg, idAttribute },
  })

  const tracker = {
    observe: inner.observe,
    unobserve: inner.unobserve,
    start: () => { activity.attach(); inner.start() },
    stop:  () => { inner.stop(); activity.detach() },
  }

  const scannerOptions = {
    selector:        options.selector        ?? DEFAULT_IMAGE_SELECTOR,
    excludeSelector: options.excludeSelector ?? DEFAULT_IMAGE_EXCLUDE,
    idAttribute,
  }
  return createOrchestrator({ tracker, ...buildScannerHooks(scannerOptions) })
}
