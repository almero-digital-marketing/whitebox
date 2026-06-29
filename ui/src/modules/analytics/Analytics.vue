<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted, onActivated } from 'vue'
import { storeToRefs } from 'pinia'
import { useRoute, useRouter } from 'vue-router'
import { useConfirm } from 'primevue/useconfirm'
import ConfirmDialog from 'primevue/confirmdialog'
import { onAnalyticsChanged } from './realtime'
import { useAnalyticsStore } from './stores/analytics'
import ReportsList from './components/ReportsList.vue'
import RailSearch from '../../components/RailSearch.vue'
import ComposePane from './components/ComposePane.vue'
import Board from './components/Board.vue'
import './analytics.css'

const confirm = useConfirm()
const route = useRoute()
const router = useRouter()
const paramStr = (p: any): string => (Array.isArray(p) ? p[0] : p) || ''

// Data lives in the store; selection lives in the URL; view/layout stays local here.
// storeToRefs keeps the template's `reports`/`current`/… names unchanged.
const store = useAnalyticsStore()
const { reports, current, widgetData, schema, composing, error } = storeToRefs(store)
// client-side rail search
const q = ref('')
const filteredReports = computed(() => {
  const s = q.value.trim().toLowerCase()
  return s ? reports.value.filter((r: any) => (r.name || '').toLowerCase().includes(s)) : reports.value
})

const selectedWidget = ref<any>(null)             // the widget the Query editor is editing (derived from the route)
const mode = ref<'agent' | 'query'>('agent')      // Agent | Query (v-model into ComposePane)
// collapse the center (compose) pane → the board goes two-column. Persisted.
const centerCollapsed = ref(localStorage.getItem('wb-center-collapsed') === '1')
// the seam handle is centered ON the border between panes — its left is the board's
// measured left edge minus half the handle width (24/2). Measured, not hardcoded.
const rightEl = ref<HTMLElement | null>(null)
const HANDLE_W = 24
const handleLeft = ref(788)
function updateHandle() { if (rightEl.value) handleLeft.value = Math.round(rightEl.value.getBoundingClientRect().left) - HANDLE_W / 2 }
watch(centerCollapsed, async (v) => {
  localStorage.setItem('wb-center-collapsed', v ? '1' : '0')
  await nextTick(); updateHandle()
})

// ── routing: the open report (reportId) and the edited widget (widgetId) live in the
// URL. Clicks push routes; the watchers below turn the route back into store calls +
// local selection. So back/forward, refresh and deep links all work. A widgetId of
// 'new' is the blank builder (a not-yet-saved widget). ──────────────────────────────

// point selectedWidget at the fresh widget object the route names (null for none / 'new')
function resolveSelectedRef() {
  const wid = paramStr(route.params.widgetId)
  selectedWidget.value = wid && wid !== 'new'
    ? (current.value?.widgets?.find((w: any) => w.id === wid) || null)
    : null
}
// derive the compose-pane mode from the route's widgetId: a selection (or 'new') opens
// the Query editor; no widget returns to Agent.
function applyWidgetMode() {
  const wid = paramStr(route.params.widgetId)
  // Only open the builder if the report the route names actually loaded — a stale
  // /<rid>/new whose report 404'd must NOT force the editor open (Save would then
  // create a detached "Untitled report").
  const reportLoaded = current.value?.id === paramStr(route.params.reportId)
  if (reportLoaded && (wid === 'new' || (wid && selectedWidget.value))) { mode.value = 'query'; centerCollapsed.value = false }
  else if (!wid && mode.value === 'query') mode.value = 'agent'
}
// reportId → which report is open. Guarded to this module's route so navigating to
// another module (this component is kept-alive, its watchers still fire) doesn't wipe state.
watch(() => route.params.reportId, async (raw) => {
  if (route.name !== 'analytics') return
  const rid = paramStr(raw)
  if (!rid) { store.clear(); return }
  if (current.value?.id !== rid) await store.openReport(rid)
  resolveSelectedRef(); applyWidgetMode()
}, { immediate: true })
// widgetId → which widget the Query editor edits
watch(() => route.params.widgetId, () => {
  if (route.name !== 'analytics') return
  resolveSelectedRef(); applyWidgetMode()
})

// navigation — clicks/handlers push the route; the watchers above apply it
function goReport(id: string) { router.push({ name: 'analytics', params: { reportId: id } }) }
function goWidget(id: string) { router.push({ name: 'analytics', params: { reportId: current.value?.id, widgetId: id } }) }
// board "+ Add widget" → blank builder. With no report yet, there's no reportId to route
// under, so fall back to local builder state (saving creates the report, then routes).
function addWidget() {
  if (!current.value) { selectedWidget.value = null; mode.value = 'query'; centerCollapsed.value = false; return }
  goWidget('new')
}
// click on empty board space / Query "Cancel" → drop the widget selection, keep the report.
function deselectWidget() {
  if (!paramStr(route.params.widgetId)) return
  router.push({ name: 'analytics', params: { reportId: current.value?.id } })
}
// Cancel from the Query editor: back out fully. Routed when a report is open; otherwise
// (building with no report yet) just reset local state to Agent.
function cancelEdit() {
  if (paramStr(route.params.widgetId)) deselectWidget()
  else { selectedWidget.value = null; mode.value = 'agent' }
}

// Ask → the store fills the report and returns its id; we sync the URL (it's already
// loaded with primed data, so the route watcher won't re-fetch).
async function compose(question: string) {
  const rid = await store.compose(question)
  if (rid && paramStr(route.params.reportId) !== rid) router.replace({ name: 'analytics', params: { reportId: rid } })
}

// Submit from the Query builder: update the selected widget, or create a new one. If
// there's no report yet, the store creates one first; then we route to the new widget.
async function saveWidget(patch: any) {
  let rid = current.value?.id
  if (!rid) { const r = await store.createReport(); if (!r) return; rid = r.id }
  if (selectedWidget.value?.id) {
    await store.updateWidget(selectedWidget.value.id, patch)
  } else {
    const row = await store.addWidget(rid, { ...patch, provenance: 'human' })
    if (row) goWidget(row.id)                              // select & edit the new widget
  }
}

function renameReport(name: string) { store.renameReport(name) }
function reorderWidgets(order: string[]) { store.reorderWidgets(order) }

// Explicit report creation — the "+" button. Store creates + opens; we route to it.
async function createReport() {
  const r = await store.createReport()
  if (r) router.push({ name: 'analytics', params: { reportId: r.id } })
}

// confirm before deleting a widget — like report delete, it can't be undone
function removeWidget(id: string) {
  const w = current.value?.widgets?.find((x: any) => x.id === id)
  confirm.require({
    header: 'Delete widget',
    message: `Delete “${w?.title || 'this widget'}”? This can’t be undone.`,
    icon: 'pi pi-trash',
    defaultFocus: 'reject',
    acceptProps: { label: 'Delete', severity: 'danger' },
    rejectProps: { label: 'Cancel', severity: 'secondary', outlined: true },
    accept: () => store.deleteWidget(id),
  })
}
// confirm before deleting — a report delete cascades all its widgets
function removeReport(report: any) {
  confirm.require({
    header: 'Delete report',
    message: `Delete “${report.name}”? This removes the report and all of its widgets. This can’t be undone.`,
    icon: 'pi pi-trash',
    defaultFocus: 'reject',
    acceptProps: { label: 'Delete', severity: 'danger' },
    rejectProps: { label: 'Cancel', severity: 'secondary', outlined: true },
    accept: () => doDeleteReport(report.id),
  })
}
async function doDeleteReport(id: string) {
  const wasCurrent = await store.deleteReport(id)
  if (wasCurrent) router.push({ name: 'analytics', params: {} })   // watcher → store.clear()
}

// Live sync. Debounced + accumulated so a burst (a compose adding N widgets, or our own
// echoes) collapses into one refresh — by which point our optimistic updates have primed
// widgetData, so openReport(keepData) is a no-op locally but resolves new widgets for OTHER tabs.
let off: (() => void) | undefined
let refreshTimer: any
let touchedCurrent = false
let currentDeleted = false
const staleWidgets = new Set<string>()
function onAnalyticsEvent({ report_id, action, widget_id }: { report_id: string; action: string; widget_id?: string }) {
  if (current.value?.id === report_id) {
    touchedCurrent = true
    if (action === 'report.deleted') currentDeleted = true
    if (action === 'widget.updated' && widget_id) staleWidgets.add(widget_id)   // its data is stale → force re-resolve
  }
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    store.loadReports()                               // rail: create / rename / delete anywhere
    if (touchedCurrent) {
      if (currentDeleted) router.push({ name: 'analytics', params: {} })   // watcher → store.clear()
      else if (current.value) {
        if (staleWidgets.size) store.invalidateWidgets([...staleWidgets])
        store.openReport(current.value.id, { keepData: true })             // open board: widgets / rename / edits
      }
    }
    touchedCurrent = false; currentDeleted = false; staleWidgets.clear()
  }, 300)
}
let ro: ResizeObserver | undefined
onMounted(async () => {
  await store.loadReports()
  store.loadSchema()
  off = onAnalyticsChanged(onAnalyticsEvent)
  updateHandle()
  // the board's width/position changes on collapse — re-measure the handle whenever it does
  ro = new ResizeObserver(() => updateHandle())
  if (rightEl.value) ro.observe(rightEl.value)
  window.addEventListener('resize', updateHandle)
})
onUnmounted(() => { off?.(); clearTimeout(refreshTimer); ro?.disconnect(); window.removeEventListener('resize', updateHandle) })
// kept-alive across module switches: onMounted doesn't re-run on return, so re-measure the
// seam handle (a window resize while away leaves it at a stale offset) and refresh the reports
// rail — a missed first load (or a report created elsewhere) shouldn't need a full refresh.
onActivated(() => { store.loadReports(); nextTick(updateHandle) })
</script>

<template>
  <div class="console" :class="{ 'center-collapsed': centerCollapsed }">
    <aside class="left">
      <ReportsList :reports="filteredReports" :current-id="current?.id"
        @open="goReport" @new="createReport" @remove="removeReport" />
      <RailSearch v-model="q" placeholder="Search reports" />
    </aside>
    <main class="center">
      <!-- v-show lives on a wrapper element, not on ComposePane directly: ComposePane has
           a multi-root (fragment) template, and v-show can't toggle display on a fragment. -->
      <div v-show="!centerCollapsed" class="compose-host">
        <ComposePane v-model:mode="mode" :composing="composing" :report="current" :selected-widget="selectedWidget" :schema="schema"
          @compose="compose" @rename="renameReport" @save="saveWidget" @cancel="cancelEdit" />
      </div>
      <p v-if="error && !centerCollapsed" class="err">{{ error }}</p>
    </main>
    <section class="right" ref="rightEl">
      <Board :report="current" :data="widgetData" :selected-id="selectedWidget?.id" :columns="centerCollapsed ? 2 : 1"
        @remove="removeWidget" @select="goWidget" @add="addWidget" @reorder="reorderWidgets" @deselect="deselectWidget" />
    </section>
    <!-- seam handle: collapse the compose pane → board goes two-column. Sits just inside
         the board's measured left edge so it never overlaps an adjacent scrollbar. -->
    <button class="seam-toggle" :style="{ left: handleLeft + 'px' }" :title="centerCollapsed ? 'Show compose pane' : 'Hide compose pane'" @click="centerCollapsed = !centerCollapsed">
      <i :class="centerCollapsed ? 'pi pi-angle-right' : 'pi pi-angle-left'" />
    </button>
  </div>
  <ConfirmDialog />
</template>
