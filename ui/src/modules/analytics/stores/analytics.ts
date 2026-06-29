// Analytics data store — owns the reports list, the open report, and each widget's
// resolved data/insight. It does the server reads/writes and the AI orchestration;
// it does NOT navigate. Selection (which report/widget is open) stays in the URL —
// the Analytics view turns the route into store calls and handles navigation itself.
// Actions that create a report return its id so the view can route to it.
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '../api'

export const useAnalyticsStore = defineStore('analytics', () => {
  const reports = ref<any[]>([])                    // the rail list
  const current = ref<any>(null)                    // { id, name, widgets[] }
  const widgetData = ref<Record<string, any>>({})   // widgetId → { data? | error? | loading | explanation | summary }
  const schema = ref<any>(null)                     // fact keys for the builder
  const composing = ref(false)
  const error = ref('')

  async function loadReports() {
    try { reports.value = (await api.listReports()).data } catch (e: any) { error.value = e.message }
  }

  async function loadSchema() {
    try { schema.value = await api.schema() } catch { /* best-effort */ }
  }

  async function resolveWidget(w: any) {
    const forReport = current.value?.id              // the report this resolve belongs to
    widgetData.value = { ...widgetData.value, [w.id]: { loading: true } }
    try {
      // NB: await FIRST, then spread — capturing the spread before awaiting lets a
      // late concurrent resolve clobber the others back to loading.
      const data = await api.resolveWidget(w.id)
      if (current.value?.id !== forReport) return    // switched reports mid-resolve → drop the stale write
      widgetData.value = { ...widgetData.value, [w.id]: { data } }
      if (w.kind !== 'answer') explainWidget(w, data) // auto-explain on load / data change (non-blocking)
    } catch (e: any) {
      if (current.value?.id !== forReport) return
      widgetData.value = { ...widgetData.value, [w.id]: { error: e.message } }
    }
  }

  // AI reads each widget's result → a 1–2 sentence insight (the left column). Best-effort.
  async function explainWidget(w: any, data: any) {
    const setExp = (patch: any) => {
      const cur = widgetData.value[w.id]
      if (cur) widgetData.value = { ...widgetData.value, [w.id]: { ...cur, ...patch } }
    }
    setExp({ explaining: true })
    try {
      const payload = (w.kind === 'stat' && w.query?.target) ? { ...data, target: w.query.target } : data
      const { explanation } = await api.explain({ id: w.id, title: w.title, kind: w.kind, data: payload })
      setExp({ explanation, explaining: false })
    } catch { setExp({ explaining: false }) }
  }

  // The subtitle (query summary) is presaved; seeded widgets have none — backfill once.
  async function ensureSummary(w: any) {
    if (w.summary) return
    try {
      const { summary } = await api.widgetSummary(w.id)
      if (!summary) return
      const cur = widgetData.value[w.id] || {}
      widgetData.value = { ...widgetData.value, [w.id]: { ...cur, summary } }
    } catch { /* best-effort */ }
  }

  // Resolve only what we don't already have. Switching reports clears stale data; a
  // live refresh of the same report keeps it and resolves only newly-added widgets.
  async function openReport(id: string, { keepData = false } = {}) {
    error.value = ''
    try {
      const switching = current.value?.id !== id
      const report = await api.getReport(id)
      current.value = report
      if (switching && !keepData) widgetData.value = {}
      report.widgets.forEach((w: any) => { if (!widgetData.value[w.id]) resolveWidget(w) })
      report.widgets.forEach((w: any) => ensureSummary(w))
    } catch (e: any) { error.value = e.message }
  }

  // Ask → fill the open report (creating one first if none). Returns the report id so
  // the view can sync the URL. Navigation is the view's job, not the store's.
  async function compose(question: string): Promise<string | null> {
    if (!question.trim()) return current.value?.id ?? null
    composing.value = true; error.value = ''
    try {
      if (!current.value) {
        const r = await api.createReport('Untitled report')
        current.value = { ...r, widgets: [] }
      }
      const res = await api.compose(question, current.value.id)   // NEW widgets WITH data
      const add: Record<string, any> = {}
      for (const w of res.widgets) add[w.id] = w.error ? { error: w.error } : { data: w.data }
      widgetData.value = { ...widgetData.value, ...add }           // merge — keep existing
      for (const w of res.widgets) if (!w.error && w.kind !== 'answer') explainWidget(w, w.data)
      await openReport(res.report.id, { keepData: true })          // refresh list, resolve only missing
      await loadReports()
      return current.value?.id ?? null
    } catch (e: any) { error.value = e.message; return current.value?.id ?? null }
    finally { composing.value = false }
  }

  async function createReport(name = 'Untitled report') {
    try {
      const r = await api.createReport(name)
      current.value = { ...r, widgets: [] }
      widgetData.value = {}; error.value = ''
      await loadReports()
      return r
    } catch (e: any) { error.value = e.message; return null }
  }

  async function renameReport(name: string) {
    if (!current.value || !name.trim() || name === current.value.name) return
    try {
      const r = await api.updateReport(current.value.id, { name: name.trim() })
      current.value = { ...current.value, name: r.name }
      await loadReports()
    } catch (e: any) { error.value = e.message }
  }

  // Delete a report. Returns true if it was the open one, so the view can navigate away.
  async function deleteReport(id: string): Promise<boolean> {
    const wasCurrent = current.value?.id === id
    try { await api.deleteReport(id); await loadReports() } catch (e: any) { error.value = e.message }
    return wasCurrent
  }

  async function updateWidget(id: string, patch: any) {
    try {
      await api.updateWidget(id, patch)
      invalidateWidgets([id])                                       // force re-resolve
      await openReport(current.value.id, { keepData: true })
      await loadReports()
    } catch (e: any) { error.value = e.message }
  }

  // Add a widget to a report; returns the created row so the view can select it.
  async function addWidget(reportId: string, patch: any) {
    try {
      const row = await api.addWidget(reportId, patch)
      await openReport(reportId, { keepData: true })
      await loadReports()
      return row
    } catch (e: any) { error.value = e.message; return null }
  }

  async function deleteWidget(id: string) {
    try {
      await api.deleteWidget(id)
      if (current.value) current.value = { ...current.value, widgets: current.value.widgets.filter((w: any) => w.id !== id) }
      invalidateWidgets([id])
      await loadReports()
    } catch (e: any) { error.value = e.message }
  }

  // Optimistic reorder to the new id order (so the echo of our own broadcast is idempotent), then persist.
  async function reorderWidgets(order: string[]) {
    if (!current.value) return
    const byId = new Map(current.value.widgets.map((w: any) => [w.id, w]))
    current.value = { ...current.value, widgets: order.map((id) => byId.get(id)).filter(Boolean) }
    try { await api.reorderWidgets(current.value.id, order) } catch (e: any) { error.value = e.message }
  }

  // Drop cached data for these widgets so the next openReport re-resolves them (live edits).
  function invalidateWidgets(ids: string[]) {
    if (!ids.length) return
    const n = { ...widgetData.value }
    for (const id of ids) delete n[id]
    widgetData.value = n
  }

  function clear() { current.value = null; widgetData.value = {}; error.value = '' }

  return {
    reports, current, widgetData, schema, composing, error,
    loadReports, loadSchema, resolveWidget, explainWidget, ensureSummary, openReport,
    compose, createReport, renameReport, deleteReport, updateWidget, addWidget, deleteWidget,
    reorderWidgets, invalidateWidgets, clear,
  }
})
