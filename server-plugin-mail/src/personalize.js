// Rewrite marked anchor tags into personalized short links.
//
// An author opts a link in with `data-wb-shorten` and (optionally) per-link UTM
// via `data-wb-utm-<field>`. At send time — once the recipient's passport is
// known — each marked link is turned into a short link bound to that passport,
// with UTM baked into the destination (send-level defaults + per-link overrides).
//
// Surgical by design: only the matched `<a …>` opening tags are modified (href
// swapped, data-wb-* attributes stripped); the rest of the HTML is left
// byte-for-byte, which matters for finicky email clients. No HTML parser dep.

function parseAttrs(attrsStr) {
  const re = /([a-zA-Z0-9_:.-]+)(?:\s*=\s*"([^"]*)"|\s*=\s*'([^']*)')?/g
  const map = {}
  let m
  while ((m = re.exec(attrsStr)) !== null) map[m[1].toLowerCase()] = m[2] ?? m[3] ?? ''
  return map
}

// In valid HTML an href's ampersands are entity-encoded (`?a=1&amp;b=2`), but
// the shortener needs a real URL (new URL() would otherwise read `&amp;` as a
// param named "amp;b"). Decode the ampersand entities before shortening; the
// delivered link is the short URL, so there's nothing to re-encode.
const decodeHref = (s) => s.replace(/&amp;/gi, '&').replace(/&#0*38;/g, '&').replace(/&#x0*26;/gi, '&')

// data-wb-utm-campaign="x" → { campaign: 'x' }
function utmFromAttrs(attrs) {
  const utm = {}
  for (const k of Object.keys(attrs)) {
    const m = /^data-wb-utm-(.+)$/.exec(k)
    if (m && attrs[k]) utm[m[1]] = attrs[k]
  }
  return utm
}

// Drop every data-wb-* attribute and set href to the short URL, preserving all
// other attributes (class/style/target/…) exactly as authored.
function rewriteAttrs(attrsStr, newHref) {
  let a = attrsStr.replace(/\s+data-wb-[a-z0-9-]+(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*')?/gi, '')
  if (/\shref\s*=\s*"/i.test(a))      a = a.replace(/(\shref\s*=\s*")[^"]*"/i, `$1${newHref}"`)
  else if (/\shref\s*=\s*'/i.test(a)) a = a.replace(/(\shref\s*=\s*')[^']*'/i, `$1${newHref}'`)
  else                                a = ` href="${newHref}"${a}`
  return a
}

// createLink: async ({ url, passport_id, utm }) => { short_url }
// utm: send-level defaults; per-link data-wb-utm-* override them.
export async function personalizeLinks(html, { createLink, passportId, utm = {}, onError } = {}) {
  if (!html || typeof createLink !== 'function' || !passportId) return html

  const anchorRe = /<a\b([^>]*)>/gi
  const tags = []
  let m
  while ((m = anchorRe.exec(html)) !== null) {
    const attrs = parseAttrs(m[1])
    if (!('data-wb-shorten' in attrs)) continue
    if (!attrs.href || !/^https?:\/\//i.test(attrs.href)) continue   // only absolute http(s)
    tags.push({ full: m[0], attrsStr: m[1], attrs, href: attrs.href })
  }
  if (!tags.length) return html

  // One createLink per distinct marked tag; reuse for identical tags.
  const replacements = new Map()
  for (const t of tags) {
    if (replacements.has(t.full)) continue
    let newHref = t.href   // fallback keeps the original (entity-encoded) href as authored
    try {
      const out = await createLink({ url: decodeHref(t.href), passport_id: passportId, utm: { ...utm, ...utmFromAttrs(t.attrs) } })
      if (out?.short_url) newHref = out.short_url
    } catch (err) {
      onError?.(err, t.href)   // keep the original href on failure
    }
    replacements.set(t.full, `<a${rewriteAttrs(t.attrsStr, newHref)}>`)
  }

  let out = html
  for (const [full, rep] of replacements) out = out.split(full).join(rep)
  return out
}
