// Thin client for the audiences plugin. Calls go to /api/audiences/* (the dev proxy
// strips /api → the server's /audiences/* surface). Same bearer token as analytics
// (the dev server registers both plugins on the same secret).

const TOKEN = (import.meta as any).env?.VITE_ANALYTICS_TOKEN || ''
const BASE = '/api/audiences'

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

// A segment `source` is the rule-shaped predicate: { select } | { funnel, slot, status }.
export const audiences = {
  // size of an unsaved source (the chip's "~N people"), reusing the engine preview
  previewSegment: (source: any) => req('/segments/preview', { method: 'POST', body: JSON.stringify({ source }) }),
  // persist (dedups on the source predicate; names with the AI if no name given). The
  // chip names itself deterministically ("<title>: <label>"); the server /segments/name
  // AI endpoint stays as the no-name-supplied fallback inside saveSegment.
  saveSegment: (body: { source: any; name?: string; origin?: any; context?: any }) =>
    req('/segments', { method: 'POST', body: JSON.stringify(body) }),
  listSegments: () => req('/segments'),
  getSegment: (id: string) => req(`/segments/${id}`),
  renameSegment: (id: string, name: string) => req(`/segments/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  deleteSegment: (id: string) => req(`/segments/${id}`, { method: 'DELETE' }),
  segmentMembers: (id: string) => req(`/segments/${id}/members`),

  // audiences — boolean compositions of segments. rule = { op:'all'|'any', members:[{segment,negate?}] }
  listAudiences: () => req('/audiences'),
  // CAPI adapters the server actually has configured (name + eligible). Drives whether a
  // network shows a live delivery toggle or a "Connect" prompt — no silent dry-run.
  listNetworks: () => req('/networks'),
  previewAudience: (rule: any) => req('/audiences/preview', { method: 'POST', body: JSON.stringify({ rule }) }),
  // AI name for an unsaved rule — used to auto-name until the user types their own.
  nameAudience: (rule: any) => req('/audiences/name', { method: 'POST', body: JSON.stringify({ rule }) }),
  saveAudience: (body: { id?: string; name?: string; rule: any; delivery?: any }) =>
    req('/audiences', { method: 'POST', body: JSON.stringify(body) }),
  getAudience: (id: string) => req(`/audiences/${id}`),
  deleteAudience: (id: string) => req(`/audiences/${id}`, { method: 'DELETE' }),
  audienceMembers: (id: string) => req(`/audiences/${id}/members`),

  // delivery: preview the deliverable cohort (after suppression + consent), then turn a
  // network on/off. The send only runs on enable, after the UI's explicit confirm.
  previewDelivery: (id: string) => req(`/audiences/${id}/delivery/preview`, { method: 'POST', body: '{}' }),
  setDelivery: (id: string, network: string, enabled: boolean) =>
    req(`/audiences/${id}/delivery`, { method: 'POST', body: JSON.stringify({ network, enabled }) }),
  // expose / hide an audience to the client side (on-site membership lookup) — immediate, no send
  setClientSide: (id: string, enabled: boolean) =>
    req(`/audiences/${id}/client-side`, { method: 'POST', body: JSON.stringify({ enabled }) }),
  // make an audience available to the Campaigns module (email & SMS) — immediate, no send
  setCampaigns: (id: string, enabled: boolean) =>
    req(`/audiences/${id}/campaigns`, { method: 'POST', body: JSON.stringify({ enabled }) }),
}
