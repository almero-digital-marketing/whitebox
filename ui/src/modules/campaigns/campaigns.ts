// Thin client for the campaigns plugin. Calls go to /api/campaigns/* (the dev proxy strips
// /api → the server's /campaigns/* surface). Same bearer token as analytics/audiences.

const TOKEN = (import.meta as any).env?.VITE_ANALYTICS_TOKEN || ''
const BASE = '/api/campaigns'

async function req(path: string, opts: any = {}): Promise<any> {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...(opts.headers || {}),
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${path} → ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`)
  }
  return res.status === 204 ? null : res.json()
}

export const campaignsClient = {
  list: () => req(''),
  get: (id: string) => req(`/${id}`),
  create: (body: { name: string; channel: 'email' | 'sms'; message?: any }) =>
    req('', { method: 'POST', body: JSON.stringify(body) }),
  patch: (id: string, body: any) => req(`/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  remove: (id: string) => req(`/${id}`, { method: 'DELETE' }),
  attachAudience: (id: string, audienceId: string) =>
    req(`/${id}/audiences`, { method: 'POST', body: JSON.stringify({ audience_id: audienceId }) }),
  detachAudience: (id: string, audienceId: string) =>
    req(`/${id}/audiences/${audienceId}`, { method: 'DELETE' }),
  previewDelivery: (id: string) => req(`/${id}/delivery/preview`, { method: 'POST', body: '{}' }),
  schedule: (id: string, counts?: any) => req(`/${id}/schedule`, { method: 'POST', body: JSON.stringify({ counts }) }),
  unlock: (id: string) => req(`/${id}/unlock`, { method: 'POST', body: '{}' }),
  setReport: (id: string, reportId: string) =>
    req(`/${id}/report`, { method: 'POST', body: JSON.stringify({ report_id: reportId }) }),
}
