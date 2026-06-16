const UTM_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']

export function extractUtms() {
  if (typeof window === 'undefined') return {}
  const params = new URLSearchParams(window.location.search)
  const utms = {}
  for (const k of UTM_FIELDS) {
    const v = params.get(k)
    if (v) utms[k] = v
  }
  return utms
}

export function getReferrer() {
  if (typeof document === 'undefined') return null
  return document.referrer || null
}
