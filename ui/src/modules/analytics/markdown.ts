// Minimal, XSS-safe Markdown → HTML for answer widgets. We escape all HTML first,
// then apply a small known subset (headings, bold, italic, inline code, ordered /
// unordered lists, links), so nothing the model (or customer data) emits can inject
// markup. Deliberately tiny — answers are prose, not documents. Swap for marked +
// DOMPurify if richer rendering is ever needed.

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function inline(t: string): string {
  return t
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
}

export function renderMarkdown(src: string): string {
  if (!src) return ''
  const lines = esc(src).split(/\r?\n/)
  const out: string[] = []
  let list: 'ul' | 'ol' | null = null
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null } }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) { closeList(); continue }

    let m: RegExpMatchArray | null
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      closeList()
      const lvl = m[1].length
      out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`)
    } else if ((m = line.match(/^[-*]\s+(.*)$/))) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul' }
      out.push(`<li>${inline(m[1])}</li>`)
    } else if ((m = line.match(/^\d+\.\s+(.*)$/))) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol' }
      out.push(`<li>${inline(m[1])}</li>`)
    } else {
      closeList()
      out.push(`<p>${inline(line)}</p>`)
    }
  }
  closeList()
  return out.join('\n')
}
