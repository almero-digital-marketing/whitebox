// Audiences data store — the shared seam for segments (and, later, audiences). Segments
// are created in Analytics (a chart/cohort selection → a saved dynamic sub-query) but
// consumed elsewhere (the Audiences module, then Campaigns), so they live in a store
// rather than any one component tree. The `audiences` client is the thin HTTP transport;
// this store holds the shared list + orchestration on top of it.
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { audiences as client } from '../audiences'

export const useAudiencesStore = defineStore('audiences', () => {
  const segments = ref<any[]>([])    // saved segments, shared across modules
  const loading = ref(false)
  const error = ref('')

  // size of an UNSAVED source (the chip's "~N people") — pure passthrough, no state.
  const previewSegment = (source: any) => client.previewSegment(source)

  async function loadSegments() {
    loading.value = true; error.value = ''
    try { segments.value = await client.listSegments() }
    catch (e: any) { error.value = e.message }
    finally { loading.value = false }
  }

  // persist a chart/cohort selection; keep the returned row in the shared list so the
  // Audiences module sees it without a reload. Dedup is server-side (same predicate →
  // one segment), so the returned row may be an existing one.
  async function saveSegment(payload: { source: any; name?: string; origin?: any; context?: any }) {
    const row = await client.saveSegment(payload)
    if (row?.id && !segments.value.some(s => s.id === row.id)) segments.value = [row, ...segments.value]
    return row
  }

  async function removeSegment(id: string) {
    await client.deleteSegment(id)
    segments.value = segments.value.filter(s => s.id !== id)
  }

  async function renameSegment(id: string, name: string) {
    const row = await client.renameSegment(id, name)
    if (row?.id) segments.value = segments.value.map(s => (s.id === row.id ? { ...s, ...row } : s))
    return row
  }

  // ── audiences — boolean compositions of segments (AND/OR/NOT) ──
  const audiences = ref<any[]>([])    // saved audiences
  const networks = ref<any[]>([])     // CAPI adapters the server has configured (name + eligible)

  async function loadAudiences() {
    try { audiences.value = await client.listAudiences() }
    catch (e: any) { error.value = e.message }
  }

  // which ad networks the server can actually deliver to (drives Connect vs live toggle)
  async function loadNetworks() {
    try { networks.value = await client.listNetworks() }
    catch (e: any) { error.value = e.message }
  }

  // size of an UNSAVED rule (the builder's live "~N people") — pure passthrough.
  const previewAudience = (rule: any) => client.previewAudience(rule)
  // AI name for an unsaved rule — auto-naming until the user types their own.
  const nameAudience = (rule: any) => client.nameAudience(rule)

  async function saveAudience(body: { id?: string; name?: string; rule: any; delivery?: any }) {
    const row = await client.saveAudience(body)
    if (row?.id) {
      const i = audiences.value.findIndex(a => a.id === row.id)
      if (i >= 0) audiences.value = audiences.value.map(a => a.id === row.id ? row : a)   // updated
      else audiences.value = [row, ...audiences.value]                                    // new
    }
    return row
  }

  async function removeAudience(id: string) {
    await client.deleteAudience(id)
    audiences.value = audiences.value.filter(a => a.id !== id)
  }

  // delivery — preview the deliverable count, then turn a network on/off (after confirm)
  const previewDelivery = (id: string) => client.previewDelivery(id)
  async function setDelivery(id: string, network: string, enabled: boolean) {
    const row = await client.setDelivery(id, network, enabled)
    if (row?.id) audiences.value = audiences.value.map(a => a.id === row.id ? row : a)   // keep the list fresh
    return row
  }

  // client-side exposure — whether the on-site SDK can read this audience's membership
  async function setClientSide(id: string, enabled: boolean) {
    const row = await client.setClientSide(id, enabled)
    if (row?.id) audiences.value = audiences.value.map(a => a.id === row.id ? row : a)
    return row
  }

  // campaigns availability — whether the Campaigns module can use this audience (email & SMS)
  async function setCampaigns(id: string, enabled: boolean) {
    const row = await client.setCampaigns(id, enabled)
    if (row?.id) audiences.value = audiences.value.map(a => a.id === row.id ? row : a)
    return row
  }

  return {
    segments, audiences, networks, loading, error,
    previewSegment, loadSegments, saveSegment, removeSegment, renameSegment,
    loadAudiences, loadNetworks, previewAudience, nameAudience, saveAudience, removeAudience,
    previewDelivery, setDelivery, setClientSide, setCampaigns,
  }
})
