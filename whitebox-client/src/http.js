// Minimal fetch wrapper. Returns parsed JSON; throws on non-2xx with a useful message.

export default function createHttp({ baseUrl }) {

  async function request(path, { method = 'GET', body, headers } = {}) {
    const init = {
      method,
      headers: {
        'accept': 'application/json',
        ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
    }
    if (body !== undefined) {
      init.body = body instanceof FormData ? body : JSON.stringify(body)
    }

    const res = await fetch(`${baseUrl}${path}`, init)
    if (!res.ok) {
      let detail
      try { detail = await res.json() } catch { detail = await res.text().catch(() => '') }
      const err = new Error(`HTTP ${res.status} ${path}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
      err.status = res.status
      err.detail = detail
      throw err
    }
    const text = await res.text()
    if (!text) return null
    try { return JSON.parse(text) } catch { return text }
  }

  function beacon(path, body) {
    if (typeof navigator === 'undefined' || !navigator.sendBeacon) return false
    const blob = new Blob([JSON.stringify(body)], { type: 'application/json' })
    return navigator.sendBeacon(`${baseUrl}${path}`, blob)
  }

  return { request, beacon }
}
