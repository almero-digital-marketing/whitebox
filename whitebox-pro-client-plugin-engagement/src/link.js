// Link-click tracking. A click on an opted-in link (`data-wb-link`) is a strong
// intent signal — the visitor actively chose to go somewhere, unlike passively
// scrolling past a paragraph. The label (what they showed interest IN) comes
// from the attribute value when set, else the link's own text. Set the attribute
// when the visible text is generic ("Learn more", "Read more") so the signal
// carries meaning, e.g. <a data-wb-link="dental implant pricing">Learn more</a>.

const GENERIC = /^(learn|read)\s+more$|^(click here|more|details|here|see more|find out more|continue|view|open|go)$/i

function hrefLabel(a) {
  try {
    const u = new URL(a.href)
    return (u.pathname.split('/').filter(Boolean).pop() || u.hostname).replace(/[-_]+/g, ' ')
  } catch {
    return a.getAttribute('href') || 'link'
  }
}

function labelFor(a) {
  const attr = (a.getAttribute('data-wb-link') || '').trim()
  if (attr) return attr                                            // explicit override wins
  const text = (a.textContent || '').trim().replace(/\s+/g, ' ')
  if (text && !GENERIC.test(text)) return text                     // meaningful anchor text
  // generic or empty text → fall back to an accessible label, then the href
  return (a.getAttribute('aria-label') || a.getAttribute('title') || '').trim() || hrefLabel(a)
}

export default function createLink({ options = {}, onClick } = {}) {
  const selector = options.selector || 'a[data-wb-link]'
  let handler = null

  function start() {
    if (handler || typeof document === 'undefined') return
    handler = (e) => {
      const a = e.target?.closest?.(selector)
      if (!a) return
      const text = labelFor(a)
      if (!text) return
      onClick?.({
        id: a.getAttribute('data-wb-link-id') || a.id || null,
        text,
        href: a.href || a.getAttribute('href') || null,
      })
    }
    // capture phase so we record even when the click navigates away immediately
    document.addEventListener('click', handler, true)
  }

  function stop() {
    if (handler) { document.removeEventListener('click', handler, true); handler = null }
  }

  return { start, stop }
}
