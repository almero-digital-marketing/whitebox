// Generic opt-in element scanner shared across engagement kinds (text, image, …).
//
// Each engagement tracker provides:
//   - selector         CSS selector for tracked elements
//   - excludeSelector  CSS selector excluding self or any ancestor (optional)
//   - idAttribute      attribute name to read stable ids from (optional)
//   - minLength        minimum textContent length (optional; 0 disables the check)
//
// `elementId` returns the value of `idAttribute` if set, otherwise hashes
// textContent (or `src` for <img> elements) as a deterministic fallback.

// Defaults per kind — exported for reuse from text/ and image/ wrappers.
export const DEFAULT_TEXT_SELECTOR = '[data-wb-text]'
export const DEFAULT_TEXT_EXCLUDE = '[data-wb-notext]'
export const DEFAULT_TEXT_ID_ATTR = 'data-wb-text'

export const DEFAULT_IMAGE_SELECTOR = '[data-wb-image]'
export const DEFAULT_IMAGE_EXCLUDE = '[data-wb-noimage]'
export const DEFAULT_IMAGE_ID_ATTR = 'data-wb-image'

export const DEFAULT_VIDEO_SELECTOR = 'video[data-wb-video]'
export const DEFAULT_VIDEO_EXCLUDE = '[data-wb-novideo]'
export const DEFAULT_VIDEO_ID_ATTR = 'data-wb-video'

function cfg(options = {}) {
  return {
    selector: options.selector,
    excludeSelector: options.excludeSelector,
    idAttribute: options.idAttribute,
    minLength: options.minLength ?? 0,
  }
}

export function findReadable(root, options = {}) {
  if (!root || typeof root.querySelectorAll !== 'function') return []
  const c = cfg(options)
  if (!c.selector) return []
  return Array.from(root.querySelectorAll(c.selector))
    .filter(el => shouldTrack(el, options))
}

export function shouldTrack(el, options = {}) {
  if (!el || el.nodeType !== 1) return false
  const c = cfg(options)
  if (!c.selector) return false
  if (typeof el.matches !== 'function' || !el.matches(c.selector)) return false
  if (c.excludeSelector && typeof el.closest === 'function' && el.closest(c.excludeSelector)) return false
  if (c.minLength > 0) {
    const text = (el.textContent || '').trim()
    if (text.length < c.minLength) return false
  }
  return true
}

// djb2 hash for stable id derivation. Non-crypto, just for dedup.
export function hashText(str) {
  let h = 5381
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i)
  return (h >>> 0).toString(36)
}

// Build the { find, match } pair the generic orchestrator expects from the
// engagement-flavoured options object (selector / excludeSelector / minLength).
// Keeps each tracker's call site one line.
export function buildScannerHooks(options = {}) {
  return {
    find:  (root) => findReadable(root, options),
    match: (el)   => shouldTrack(el, options),
  }
}

export function elementId(el, options = {}) {
  const c = cfg(options)
  if (c.idAttribute) {
    const explicit = el.getAttribute?.(c.idAttribute)
    if (explicit && explicit !== '') return explicit
  }
  // Hash basis: src for <img>, otherwise textContent
  const tag = el.tagName?.toLowerCase()
  let basis = ''
  if (tag === 'img') basis = el.currentSrc || el.src || el.getAttribute?.('src') || ''
  if (!basis) basis = (el.textContent || '').trim()
  return 'wb:' + hashText(basis)
}
