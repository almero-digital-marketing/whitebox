<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import WidgetChart from './WidgetChart.vue'
import { renderMarkdown } from '../markdown'
import { api } from '../api'
import { useAudiencesStore } from '../stores/audiences'

const props = defineProps<{ widget: any; state: any; selected?: boolean }>()
const emit = defineEmits(['remove', 'select'])

// segments are created here but live in the shared audiences store (consumed by the
// Audiences/Campaigns modules), so preview + save go through it, not a bare client.
const audiencesStore = useAudiencesStore()

const PAGE_ROWS = 10   // table rows per page — pages instead of an inner scrollbar

const d = computed(() => props.state?.data)
// timeseries returns a bare [{bucket,value}]; breakdown/funnel return { series:[...] };
// scatter returns { points:[{x,y,...}], x, y }; a compare returns { multi, series:[{name,points}] }.
const multi = computed(() => (d.value?.multi ? d.value : null))
const isMulti = computed(() => !!multi.value)
const points = computed(() => {
  const x = d.value
  if (x?.multi) return []           // multi-series flows through the `multi` prop instead
  if (Array.isArray(x)) return x
  if (x?.points) return x.points
  if (x?.series) return x.series
  return []
})
// scatter axis labels (the two fact keys) — passed through to the chart for axis names
const axes = computed(() => (d.value?.x && d.value?.y ? { x: d.value.x, y: d.value.y } : undefined))
// stat compare: each series' total, plus a delta when exactly two
const statCompare = computed(() => (multi.value?.series || []).map((s: any) => ({ name: s.name, value: s.points.reduce((a: number, p: any) => a + (p.value || 0), 0) })))
const statDelta = computed(() => {
  const c = statCompare.value
  if (c.length !== 2 || !c[1].value) return ''
  const pct = Math.round(((c[0].value - c[1].value) / c[1].value) * 100)
  return `${pct >= 0 ? '+' : ''}${pct}%`
})
const isChart = computed(() => ['timeseries', 'breakdown', 'funnel', 'dropoff', 'donut', 'distribution', 'radar', 'scatter', 'heatmap', 'cohort'].includes(props.widget.kind))
// kinds whose elements can be turned into a segment (a click derives a cohort) — used
// to signal selectability (pointer cursor + hover hint) and route the chart's @select.
const SELECTABLE_KINDS = ['dropoff', 'funnel', 'breakdown', 'donut', 'distribution']
const selectable = computed(() => SELECTABLE_KINDS.includes(props.widget.kind))
// a whole list/stat IS a people cohort → its selector is the segment source (no element
// to pick). Only when the selector actually narrows — an "everyone" list isn't an audience.
const selectorNarrows = computed(() => { const s = props.widget.query?.selector; return !!(s && (s.filter || s.about || s.judge)) })
const wholeCohort = computed(() => !isMulti.value && ['table', 'stat'].includes(props.widget.kind) && selectorNarrows.value)
// pivot: normalise the result (multi or single) into a rows × cols grid of values
const matrix = computed(() => {
  const dv: any = d.value
  let series: any[]
  if (dv?.multi) series = dv.series
  else if (Array.isArray(dv)) series = [{ name: 'value', points: dv }]
  else if (dv?.series) series = [{ name: 'value', points: dv.series }]
  else return null
  const rows: string[] = []; const seen = new Set<string>()
  for (const s of series) for (const p of s.points) if (!seen.has(p.bucket)) { seen.add(p.bucket); rows.push(p.bucket) }
  const maps = series.map((s: any) => new Map(s.points.map((p: any) => [p.bucket, p.value])))
  const grid = rows.map((r) => maps.map((m) => (m.get(r) ?? 0)))
  return { rows, cols: series.map((s: any) => s.name), grid, unit: dv?.unit || '' }
})
const fmtCell = (v: number, unit = matrix.value?.unit || '') => `${(v ?? 0).toLocaleString()}${unit}`
const rowTotal = (ri: number) => (matrix.value?.grid[ri] || []).reduce((a, b) => a + b, 0)
const colTotal = (ci: number) => (matrix.value?.grid || []).reduce((a, r) => a + (r[ci] || 0), 0)
const grandTotal = computed(() => (matrix.value?.grid || []).reduce((a, r) => a + r.reduce((x, y) => x + y, 0), 0))
const showTotals = computed(() => !!matrix.value && !matrix.value.unit && matrix.value.cols.length > 1)
const passports = computed(() => d.value?.passports || [])
// "Why" only exists on judge (LLM-predicate) matches; deterministic filters carry
// matched_at instead. Show whichever column actually has data, never an empty one.
const hasWhy = computed(() => passports.value.some((p: any) => p.why))
const hasMatched = computed(() => !hasWhy.value && passports.value.some((p: any) => p.matched_at))
const shortId = (id: string) => (id || '').slice(0, 8)
const fmtDate = (s: string) => { try { return new Date(s).toLocaleDateString() } catch { return s } }
// the card subtitle = the persisted AI summary of the query (the same plain-language
// reading the Agent tab shows). Prefer a freshly-backfilled one from state, else the
// stored widget.summary.
const querySummary = computed(() => props.state?.summary ?? props.widget.summary ?? '')
// KPI: an optional goal on a stat widget → show progress toward it
const target = computed(() => { const t = props.widget.query?.target; return typeof t === 'number' && t > 0 ? t : null })
const kpiPct = computed(() => (target.value ? Math.round(((d.value?.count ?? 0) / target.value) * 100) : 0))

// Selecting a row in a list widget swaps the Insight column to an AI profile of
// THAT client (status, value, last/next treatment, recent activity). Cleared when
// the row is deselected or the widget re-resolves to a fresh result set.
const selectedPerson = ref<any>(null)
const personInsight = ref('')
const personLoading = ref(false)
watch(selectedPerson, async (p) => {
  personInsight.value = ''
  if (!p) return
  personLoading.value = true
  try {
    const { explanation } = await api.personInsight(p.id, { label: p.label, context: props.widget.title })
    if (selectedPerson.value?.id === p.id) personInsight.value = explanation   // ignore a stale response
  } catch { /* best-effort — leave the profile blank */ }
  finally { personLoading.value = false }
})
watch(d, () => { selectedPerson.value = null })   // new result → drop the (now stale) row selection

// Selecting a chart element → a SEGMENT (a chart-derived dynamic sub-query). The chip
// appears in the insight column with an AI name + live size; Save persists it to the
// audiences plugin. v1: drop-off bars (the lost cohort = funnel-slot gap:i+1→i+2).
const pendingSegment = ref<any>(null)
// which chart element stays highlighted: the pending (pre-decision) selection — clears on Save or Dismiss
const selectedBarIndex = computed(() => {
  const ps = pendingSegment.value
  return ps && !ps.saved ? ps.index : null
})
// multi-series: the (bucket × series) bar kept lit while its chip is open
const selectedMulti = computed(() => {
  const ps = pendingSegment.value
  return ps && !ps.saved && ps.kind === 'breakdown-split' ? { bucket: ps.bucket, series: ps.series } : null
})
let segToken = 0   // primitive id: identify the active selection across async name/size (ref deep-wraps objects, so compare a token, not identity)
const coerce = (v: any) => {
  if (typeof v !== 'string') return v
  if (v === 'true') return true
  if (v === 'false') return false
  if (v !== '' && !isNaN(Number(v))) return Number(v)
  return v
}
// a breakdown/donut bucket value → a people filter, by the dimension's type
function dimFilter(dim: string, value: any): any {
  if (dim.startsWith('fact:')) return { fact: { [dim.slice(5)]: { eq: coerce(value) } } }
  if (dim.startsWith('attr:')) return { metric: { attrs: { [dim.slice(5)]: value }, count: { gte: 1 } } }
  if (dim === 'channel') return { metric: { channel: value, count: { gte: 1 } } }
  if (dim === 'session:utm_campaign') return { metric: { session: { utm_campaign: value }, count: { gte: 1 } } }
  if (dim === 'session:utm_source') return { metric: { session: { utm_source: value }, count: { gte: 1 } } }
  return { fact: { [dim]: { eq: coerce(value) } } }
}
// a chart selection → the segment source (a dynamic selector) + a label, per chart kind
function deriveSegment(sel: any): { source: any; label: string } | null {
  const q = props.widget.query || {}
  if (sel.kind === 'dropoff') {
    if (!q.funnel || sel.index == null) return null
    return { source: { funnel: q.funnel, slot: `gap:${sel.index + 1}→${sel.index + 2}` }, label: `${sel.from} → ${sel.to}` }
  }
  if (sel.kind === 'funnel') {   // a step's completers
    if (!q.funnel || sel.index == null) return null
    return { source: { funnel: q.funnel, slot: `step:${sel.index + 1}` }, label: sel.name }
  }
  if (sel.kind === 'breakdown' || sel.kind === 'donut') {
    const filter = q.breakdownFact
      ? { fact: { [q.breakdownFact.key]: { eq: coerce(sel.bucket) } } }
      : q.group?.by ? dimFilter(q.group.by, sel.bucket) : null
    if (!filter) return null
    return { source: { select: { filter } }, label: String(sel.bucket) }
  }
  if (sel.kind === 'breakdown-split') {   // a multi-series bar = bucket (group.by) AND series (splitBy)
    const by = q.group?.by, splitKey = q.splitBy?.key
    if (!by || !splitKey || sel.bucket == null || sel.series == null) return null   // series-compares have no single split dim
    const filter = { all: [dimFilter(by, sel.bucket), dimFilter(splitKey, sel.series)] }
    return { source: { select: { filter } }, label: `${sel.bucket} · ${sel.series}` }
  }
  if (sel.kind === 'distribution') {
    const d = q.distribution
    if (!d?.key || sel.lo == null) return null
    // the bin's numeric range [lo, hi); the last (closed) bin has no upper bound
    const range: any = sel.last ? { gte: sel.lo } : { gte: sel.lo, lt: sel.hi }
    const filter = d.source === 'event'
      ? { metric: { attrs: { event: d.key }, count: range } }   // people who did the event N times, N in the bin
      : { fact: { [d.key]: range } }                             // people whose fact value is in the bin
    return { source: { select: { filter } }, label: String(sel.bucket) }
  }
  return null
}
async function onChartSelect(sel: any) {
  const derived = deriveSegment(sel)
  if (!derived) return
  const token = ++segToken
  const name = `${props.widget.title}: ${derived.label}`
  const context = { chart: sel.kind, label: name, widget: props.widget.title }
  pendingSegment.value = { token, index: sel.index, kind: sel.kind, bucket: sel.bucket, series: sel.series, source: derived.source, context, name, size: null, sizing: true, saving: false, saved: false, error: '' }
  // size only — best-effort; ignore if the user picked a different element since. On
  // failure clear `sizing` so the chip shows "size unavailable", not a stuck "sizing…".
  audiencesStore.previewSegment(derived.source)
    .then((r) => { if (pendingSegment.value?.token === token) { pendingSegment.value.size = r?.est_matches ?? r?.candidate_pool ?? null; pendingSegment.value.sizing = false } })
    .catch(() => { if (pendingSegment.value?.token === token) pendingSegment.value.sizing = false })
}
async function saveSegment() {
  const ps = pendingSegment.value
  if (!ps || ps.saving || ps.saved) return
  ps.saving = true; ps.error = ''
  try {
    const row = await audiencesStore.saveSegment({
      source: ps.source, name: ps.name || undefined, context: ps.context,
      origin: { widget_id: props.widget.id, report_id: props.widget.report_id, selection: ps.context },
    })
    ps.name = row?.name || ps.name; ps.saving = false; ps.saved = true
  } catch (e: any) { ps.saving = false; ps.error = e.message }
}
// the whole list/stat → a segment: source = the widget's selector, name = its title,
// size = the count we already have (no preview call needed).
function onCreateListSegment() {
  const selector = props.widget.query?.selector
  if (!selector) return
  const token = ++segToken
  const source = { select: selector }
  const name = props.widget.title
  const knownCount = d.value?.count ?? d.value?.passports?.length ?? null
  pendingSegment.value = { token, index: null, source, context: { chart: 'list', label: name, widget: name }, name, size: knownCount, sizing: knownCount == null, saving: false, saved: false, error: '' }
  if (knownCount == null) audiencesStore.previewSegment(source)
    .then((r) => { if (pendingSegment.value?.token === token) { pendingSegment.value.size = r?.est_matches ?? r?.candidate_pool ?? null; pendingSegment.value.sizing = false } })
    .catch(() => { if (pendingSegment.value?.token === token) pendingSegment.value.sizing = false })
}
function dismissSegment() { pendingSegment.value = null }
// whole-cohort widgets (stat / narrowing list): the segment IS the whole cohort, so create it
// eagerly and keep it in the DOM (CSS hides it until hover). That reserves its height, so
// revealing it on hover never reflows the card. Refresh the size on re-resolve; recreate only
// when the SELECTOR changes (keying on `d`'s identity alone would strand it on a stale count).
watch([wholeCohort, () => JSON.stringify(props.widget.query?.selector ?? null), d], () => {
  if (!wholeCohort.value || !d.value || !props.widget.query?.selector) return
  const ps = pendingSegment.value
  const desired = JSON.stringify({ select: props.widget.query.selector })
  if (!ps || JSON.stringify(ps.source) !== desired) onCreateListSegment()                  // first time, or the query changed
  else if (!ps.saved) ps.size = d.value?.count ?? d.value?.passports?.length ?? ps.size     // same segment, fresher count
}, { immediate: true })
</script>

<template>
  <div class="card" :class="{ selected }">
    <!-- header row: title/subtitle (the drag handle) on the left, Edit/Remove on the right,
         vertically centred. The actions stay a SIBLING of .card-head — not inside it — so
         they aren't part of the drag handle (handle=".card-head") and don't start a drag. -->
    <div class="card-top">
      <div class="card-head">
        <h3 class="title">{{ widget.title }}</h3>
        <p v-if="querySummary" class="subtitle">{{ querySummary }}</p>
      </div>
      <!-- explicit Edit (opens the Query editor) + Remove; revealed on header hover -->
      <div class="actions" @click.stop>
        <Button label="Edit" icon="pi pi-pencil" text size="small" severity="secondary"
          aria-label="Edit query" title="Edit query" @click="emit('select', widget.id)" />
        <Button label="Remove" icon="pi pi-trash" text size="small" severity="secondary"
          aria-label="Remove widget" title="Remove widget" @click="emit('remove', widget.id)" />
      </div>
    </div>

    <div class="card-main" :class="{ wide: widget.kind === 'answer' }">
      <!-- left ~1/3: AI insight — the whole result, or a profile of the selected client -->
      <aside v-if="widget.kind !== 'answer'" class="explain-col" @click.stop>
        <div class="insight-main">
          <div class="explain-head">
            <i :class="selectedPerson ? 'pi pi-user' : 'pi pi-sparkles'" />{{ selectedPerson ? 'Client' : 'Insight' }}
            <button v-if="selectedPerson" type="button" class="clear-sel" @click="selectedPerson = null">show all</button>
          </div>
          <template v-if="selectedPerson">
            <p class="explain-text who-line">{{ selectedPerson.label || shortId(selectedPerson.id) }}</p>
            <p v-if="personInsight" class="explain-text">{{ personInsight }}</p>
            <p v-else-if="personLoading" class="explain-text dim">Reading this client…</p>
            <p v-else class="explain-text dim">—</p>
          </template>
          <template v-else>
            <p v-if="state?.explanation" class="explain-text">{{ state.explanation }}</p>
            <p v-else-if="state?.explaining" class="explain-text dim">Reading the result…</p>
            <p v-else class="explain-text dim">—</p>
          </template>
        </div>

        <!-- segment: paired with the insight (stacked under it when wide, beside it in the
             breakpoint). Always in the DOM for selectable charts so the breakpoint reserves
             its half (no reflow on reveal); CSS hides it in the wide layout until the chart
             is hovered or a selection is pending. Hidden while a single person is selected. -->
        <div v-if="!selectedPerson && (pendingSegment || (selectable && (points.length || isMulti)))"
             class="seg" :class="{ pinned: pendingSegment && pendingSegment.kind }">
          <div class="explain-head"><i class="pi pi-bookmark" />Segment</div>
          <template v-if="pendingSegment">
            <template v-if="wholeCohort">
              <div v-if="pendingSegment.saved" class="seg-done"><i class="pi pi-check" /> Saved to segments</div>
              <Button v-else label="Save segment" size="small" :loading="pendingSegment.saving" @click="saveSegment" />
              <p v-if="pendingSegment.error" class="seg-err">{{ pendingSegment.error }}</p>
            </template>
            <template v-else>
              <div class="seg-name">{{ pendingSegment.name }}</div>
              <div class="seg-size">{{ pendingSegment.size != null ? `~${pendingSegment.size.toLocaleString()} people` : (pendingSegment.sizing ? 'sizing…' : 'size unavailable') }}</div>
              <div v-if="pendingSegment.saved" class="seg-done"><i class="pi pi-check" /> Saved to segments</div>
              <div v-else class="seg-actions">
                <Button label="Save segment" size="small" :loading="pendingSegment.saving" @click="saveSegment" />
                <button type="button" class="seg-dismiss" @click="dismissSegment">Dismiss</button>
              </div>
              <p v-if="pendingSegment.error" class="seg-err">{{ pendingSegment.error }}</p>
            </template>
          </template>
          <div v-else-if="selectable" class="seg-hint-text">Click to create a segment</div>
        </div>
      </aside>

      <!-- right ~2/3: the result -->
      <div class="content-col">
        <div v-if="state?.loading" class="body muted pad">Loading…</div>
        <div v-else-if="state?.error" class="body err pad">{{ state.error }}</div>

        <template v-else>
          <div v-if="widget.kind === 'stat' && isMulti" class="body stat-compare">
            <div v-for="(s, i) in statCompare" :key="i" class="sc-cell">
              <div class="sc-num">{{ s.value.toLocaleString() }}</div>
              <div class="sc-name">{{ s.name }}</div>
            </div>
            <div v-if="statDelta" class="sc-delta" :class="{ down: statDelta.startsWith('-') }">{{ statDelta }}</div>
          </div>
          <div v-else-if="widget.kind === 'stat' && target" class="body kpi">
            <div class="stat">{{ (d?.count ?? 0).toLocaleString() }}<span class="stat-label">of {{ target.toLocaleString() }}</span></div>
            <div class="kpi-bar"><div class="kpi-fill" :class="{ over: kpiPct >= 100 }" :style="{ width: Math.min(100, kpiPct) + '%' }" /></div>
            <div class="kpi-meta">{{ kpiPct }}% of target</div>
          </div>
          <div v-else-if="widget.kind === 'stat'" class="body stat">
            {{ (d?.count ?? 0).toLocaleString() }}<span class="stat-label">people</span>
          </div>

          <div v-else-if="isChart" class="body chart" :class="{ selectable }">
            <WidgetChart v-if="points.length || isMulti" :kind="widget.kind" :points="points" :axes="axes" :multi="multi" :stack="widget.query?.stack" :selected-index="selectedBarIndex" :selected-multi="selectedMulti" @select="onChartSelect" />
            <p v-else class="muted">No data.</p>
          </div>

          <div v-else-if="widget.kind === 'pivot'" class="body pivot-body">
            <table v-if="matrix && matrix.rows.length" class="pivot">
              <thead>
                <tr><th class="corner"></th><th v-for="c in matrix.cols" :key="c">{{ c }}</th><th v-if="showTotals" class="tot">Total</th></tr>
              </thead>
              <tbody>
                <tr v-for="(r, ri) in matrix.rows" :key="r">
                  <th class="rh">{{ r }}</th>
                  <td v-for="(v, ci) in matrix.grid[ri]" :key="ci">{{ fmtCell(v) }}</td>
                  <td v-if="showTotals" class="tot">{{ fmtCell(rowTotal(ri)) }}</td>
                </tr>
              </tbody>
              <tfoot v-if="showTotals">
                <tr><th class="rh">Total</th><td v-for="(c, ci) in matrix.cols" :key="ci">{{ fmtCell(colTotal(ci)) }}</td><td class="tot">{{ fmtCell(grandTotal) }}</td></tr>
              </tfoot>
            </table>
            <p v-else class="muted">No data.</p>
          </div>

          <div v-else-if="widget.kind === 'answer'" class="body answer md" v-html="renderMarkdown(d?.answer || 'No answer.')" />

          <div v-else-if="widget.kind === 'table'" class="body table-body" @click.stop>
            <div class="count muted">{{ (d?.count ?? passports.length).toLocaleString() }} people<span class="hint-sel"> · click a row for a profile</span></div>
            <DataTable v-if="passports.length" :value="passports" size="small"
              v-model:selection="selectedPerson" selectionMode="single" dataKey="id"
              :paginator="passports.length > PAGE_ROWS" :rows="PAGE_ROWS" :alwaysShowPaginator="false">
              <Column header="Person">
                <template #body="{ data }">
                  <div class="person" :title="data.label || data.id">
                    <span class="who" :class="{ mono: !data.label }">{{ data.label || shortId(data.id) }}</span>
                  </div>
                </template>
              </Column>
              <!-- masked contact columns — the server only ever sends the masked form -->
              <Column header="Email">
                <template #body="{ data }"><span class="contact">{{ data.contacts?.email || '—' }}</span></template>
              </Column>
              <Column header="Phone" :style="{ width: '8rem' }">
                <template #body="{ data }"><span class="contact">{{ data.contacts?.phone || '—' }}</span></template>
              </Column>
              <Column v-if="hasWhy" field="why" header="Why" />
              <Column v-else-if="hasMatched" header="Matched" :style="{ width: '6.5rem' }">
                <template #body="{ data }"><span class="muted">{{ data.matched_at ? fmtDate(data.matched_at) : '—' }}</span></template>
              </Column>
            </DataTable>
            <p v-else class="muted">No matches.</p>
          </div>

          <div v-else class="body muted pad">Unsupported widget.</div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* a document section — no card chrome: transparent, borderless, no shadow */
/* container-type: inline-size → each card queries its OWN width (which depends on the
   board's column count + whether the compose pane is open, not the viewport), so a
   narrow card can stack its insight/segment columns below the content. See @container below. */
.card { position: relative; background: transparent; border-radius: 10px; display: flex; flex-direction: column; cursor: pointer; container-type: inline-size; }
.card.selected { outline: 1.5px solid var(--border-2); outline-offset: 8px; border-radius: 6px; }   /* a light border, no fill */
/* header row: title/subtitle + actions, vertically centred */
.card-top { display: flex; align-items: center; gap: 12px; margin-bottom: 9px; }
/* the title is a standard heading; it doubles as the drag handle and wraps in full */
.card-head { flex: 1 1 auto; min-width: 0; cursor: grab; }
.card-head:active { cursor: grabbing; }
.title { margin: 0; font-weight: 650; font-size: 15px; line-height: 1.3; color: var(--text-strong); word-break: break-word; }
/* query summary — what the widget actually measures, in plain language */
.subtitle { margin: 3px 0 0; font-size: 11.5px; font-weight: 400; line-height: 1.35; color: var(--muted); word-break: break-word; }

/* action cluster — in-flow at the right of the header row, hidden until hover */
.actions { flex: none; display: flex; align-items: center; opacity: 0; transition: opacity .12s; pointer-events: none; }
/* reveal on header-row hover; the .actions:hover bridge keeps them reachable as the
   pointer moves onto the buttons. */
.card-top:hover .actions, .actions:hover { opacity: 1; pointer-events: auto; }

/* two-column: AI insight on the left (~1/3), the result on the right (~2/3) */
.card-main { display: flex; gap: 24px; align-items: flex-start; }
.card-main.wide { display: block; }   /* answer widgets span the full width */
/* EVERY widget reads the same: content on the left, the AI insight in a fixed 31% column on
   the right — so insights (and the segment stacked beneath them) line up across stat, chart,
   table and pivot cards when they stack in a report. */
.explain-col { flex: 0 0 31%; min-width: 0; order: 1; }   /* insight on the right */
.content-col { flex: 1 1 auto; min-width: 0; order: 0; }

/* Narrow card (a 2-column board, or the compose pane open) → stack vertically: the
   content stays on top; the insight (and a stat's segment) fall BELOW it at full width
   instead of being squeezed into a 31% side column. Queried against this card's own
   width via container-type on .card — so it reacts to columns/compose, not the viewport. */
/* ── Breakpoint: when a card itself is narrow (a 2-column board, or the compose pane open),
   EVERY widget reads the same — content full-width on top, then its insight and segment side
   by side beneath it (each half, top-aligned). The segment half is always reserved so
   revealing it never reflows the card. Queried against the card's own width. ── */
@container (max-width: 540px) {
  .card-main { display: flex; flex-direction: column; align-items: stretch; gap: 14px; }
  .content-col { width: 100%; order: 0; }
  /* charts/tables: the insight and its (reserved) segment split the row below 50/50, top-aligned */
  .explain-col { width: 100%; order: 1; display: flex; flex-direction: row; align-items: flex-start; gap: 16px; }
  .explain-col .insight-main { flex: 1 1 0; min-width: 0; }
  .explain-col .seg { flex: 1 1 0; min-width: 0; margin: 0; }
}
.explain-head { display: flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin-bottom: 7px; }
.explain-head .pi { font-size: 11px; color: var(--accent); }
/* "show all" — clears the row selection, back to the whole-list insight */
.clear-sel { margin-left: auto; border: none; background: none; cursor: pointer; font: inherit; font-size: 9.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--accent); padding: 0; }
.clear-sel:hover { text-decoration: underline; }
.explain-text { margin: 0; font-size: 12.5px; line-height: 1.55; color: var(--text); }
.explain-text.dim { color: var(--muted); }
.explain-text.who-line { font-weight: 650; color: var(--text-strong); margin-bottom: 4px; word-break: break-word; }

/* segment from a chart selection — flows below the insight, no box/card chrome.
   Hidden in the wide layout until the chart is hovered or a selection is pending; the
   breakpoint rule above forces it visible + reserved so revealing it never reflows. */
/* the segment keeps its height when hidden (visibility, not display) so revealing it on hover
   never reflows the card. Shown on card hover, or pinned while a chart element is selected. */
.seg { margin: 14px 0 0; visibility: hidden; }
.card:hover .seg, .seg.pinned { visibility: visible; }
.seg-hint-text { font-size: 12.5px; color: var(--muted); }
.seg-name { font-size: 12.5px; font-weight: 650; color: var(--text-strong); word-break: break-word; }
.seg-size { font-size: 11px; color: var(--muted); margin: 2px 0 8px; }
.seg-actions { display: flex; align-items: center; gap: 8px; }
.seg-dismiss { border: none; background: none; cursor: pointer; font: inherit; font-size: 11px; color: var(--muted); padding: 0; }
.seg-dismiss:hover { color: var(--text); text-decoration: underline; }
.seg-done { display: flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 600; color: var(--accent); }
.seg-err { margin: 6px 0 0; font-size: 11px; color: var(--danger); }

/* bodies — content-driven; charts a fixed height, tables paginate (full height), answers cap+scroll */
.body { padding: 0; }
.body.pad { padding: 0; }
.chart { height: 240px; }
/* selectable charts (a click → a segment) get a pointer cursor; the textual
   "create a segment" affordance lives in the segment section under the insight. */
.chart.selectable { cursor: pointer; }
.stat { font-size: 40px; font-weight: 700; display: flex; align-items: baseline; gap: 8px; line-height: 1; color: var(--text-strong); }
.stat-label { font-size: 13px; color: var(--muted); font-weight: 400; }
/* KPI — count as progress toward a goal */
.kpi { display: flex; flex-direction: column; gap: 8px; }
.kpi-bar { width: 220px; max-width: 100%; height: 7px; border-radius: 999px; background: var(--panel-2); border: 1px solid var(--border); overflow: hidden; }
.kpi-fill { height: 100%; border-radius: 999px; background: var(--accent); transition: width .3s ease; }
.kpi-fill.over { background: #10b981; }
.kpi-meta { font-size: 12px; color: var(--muted); }
/* stat compare — N numbers side by side, with a delta pill for two */
.stat-compare { display: flex; align-items: baseline; gap: 24px; flex-wrap: wrap; }
.sc-cell { display: flex; flex-direction: column; gap: 3px; }
.sc-num { font-size: 34px; font-weight: 700; line-height: 1; color: var(--text-strong); }
.sc-name { font-size: 12px; color: var(--muted); }
.sc-delta { align-self: center; font-size: 13px; font-weight: 700; color: #10b981; background: color-mix(in srgb, #10b981 14%, transparent); border-radius: 999px; padding: 2px 9px; }
.sc-delta.down { color: #f43f5e; background: color-mix(in srgb, #f43f5e 14%, transparent); }
.answer { font-size: 14px; line-height: 1.6; max-height: 460px; overflow: auto; }
.md :deep(p) { margin: 0 0 10px; }
.md :deep(p:last-child), .md :deep(ul:last-child), .md :deep(ol:last-child) { margin-bottom: 0; }
.md :deep(h1), .md :deep(h2), .md :deep(h3), .md :deep(h4) { margin: 12px 0 6px; font-size: 14px; font-weight: 700; }
.md :deep(ul), .md :deep(ol) { margin: 6px 0 10px; padding-left: 20px; }
.md :deep(li) { margin: 3px 0; }
.md :deep(strong) { color: var(--text-strong); font-weight: 700; }
.md :deep(a) { color: var(--accent); }
.md :deep(code) { background: var(--panel-2); border: 1px solid var(--border); border-radius: 5px; padding: 1px 5px; font-size: 12px; font-family: ui-monospace, monospace; }
/* pivot — a 2-D matrix table (rows × compare columns) */
.pivot-body { padding: 0; overflow-x: auto; }
.pivot { border-collapse: collapse; font-size: 12.5px; min-width: 100%; }
.pivot th, .pivot td { padding: 6px 12px; text-align: right; white-space: nowrap; border-bottom: 1px solid var(--border); }
.pivot thead th { font-size: 11px; font-weight: 600; color: var(--muted); border-bottom: 1px solid var(--border-2); }
.pivot .corner, .pivot .rh { text-align: left; }
.pivot .rh { font-weight: 500; color: var(--text-strong); }
.pivot tbody td { color: var(--text); font-variant-numeric: tabular-nums; }
.pivot .tot { font-weight: 650; color: var(--text-strong); }
.pivot tfoot th, .pivot tfoot td { border-bottom: none; border-top: 1px solid var(--border-2); font-weight: 650; color: var(--text-strong); }
.table-body { padding: 0; }
.count { font-size: 12px; margin-bottom: 8px; padding: 0 2px; }
.hint-sel { color: var(--muted); opacity: .65; }
/* rows are pickable — show it on hover, and highlight the selected client */
.table-body :deep(.p-datatable-tbody > tr) { cursor: pointer; }
.table-body :deep(.p-datatable-tbody > tr.p-datatable-row-selected) { background: var(--accent-soft); }
.table-body :deep(.p-datatable-tbody > tr.p-datatable-row-selected .who) { color: var(--accent); }
.person { display: flex; flex-direction: column; gap: 1px; line-height: 1.3; min-width: 0; }
.who { font-weight: 500; color: var(--text-strong); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.who.mono { font-family: ui-monospace, monospace; font-weight: 400; color: var(--accent); }
/* masked email / phone — muted, monospaced so the • mask aligns; ellipsis if long */
.contact { font-size: 12px; color: var(--muted); font-family: ui-monospace, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; }
/* match the document scale — PrimeVue's default table font (~14px) reads too large here */
.table-body :deep(.p-datatable) { font-size: 12.5px; }
.table-body :deep(.p-datatable-table) { width: 100%; table-layout: fixed; }
.table-body :deep(td), .table-body :deep(th) { overflow: hidden; padding: 6px 8px; }
.table-body :deep(th) { font-size: 11px; font-weight: 600; color: var(--muted); }
/* paginator — PrimeVue doesn't shrink it with the table's small size, so size its
   controls down to match the "Add widget" button (37px tall, 13px) */
.table-body :deep(.p-paginator) { padding: 2px 0; font-size: 13px; }
.table-body :deep(.p-paginator-page),
.table-body :deep(.p-paginator-first),
.table-body :deep(.p-paginator-prev),
.table-body :deep(.p-paginator-next),
.table-body :deep(.p-paginator-last) { min-width: 33px; width: 33px; height: 33px; font-size: 13px; }
.table-body :deep(.p-paginator-page) { margin: 0 1px; }
.table-body :deep(.p-paginator .p-select) { height: 33px; }
</style>
