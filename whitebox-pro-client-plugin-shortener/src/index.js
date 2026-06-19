// Shortener client plugin — the landing-page half of a personalized short link.
//
// When a click arrives via a short link, the server's redirect left a single-use
// claim token in the URL (`?wb=` or `#wb=`). This plugin redeems it: the server
// returns the customer the link was bound to (merging this browser's anonymous
// passport into them server-side), and we adopt that passport for the session +
// expose the link's prefill data as `wb.shortener.data`.

export default function shortenerPlugin() {
  return {
    name: 'shortener',

    async install(core) {
      const { http, getPassportId, setPassportId, attach, logger } = core

      if (typeof location === 'undefined') return attach('shortener', { data: null })

      // The token rides in EITHER the query or the fragment (the server picked
      // per-destination); read whichever is present.
      const url = new URL(location.href)
      const token = url.searchParams.get('wb')
                 || new URLSearchParams(url.hash.replace(/^#/, '')).get('wb')
      if (!token) return attach('shortener', { data: null })

      // Redeem the ticket — pass our current (anonymous) passport so the server
      // can merge it into the customer the link belongs to.
      const res = await http.request('/shortener/claim', {
        method: 'POST',
        body: { token, passport_id: getPassportId?.() },
      }).catch(err => { logger?.warn?.('shortener: claim failed', err); return null })

      // Scrub the token from the address bar so it can't be re-shared/re-claimed.
      url.searchParams.delete('wb')
      if (url.hash.includes('wb=')) url.hash = ''
      try { history.replaceState(null, '', url.toString()) } catch {}

      // Become that customer, and expose the prefill.
      if (res?.bound && res.passport_id) setPassportId?.(res.passport_id)
      attach('shortener', { data: res?.data ?? null, bound: !!res?.bound })
    },
  }
}
