// The Query builder's whole form model — state + parse (query def → form) + build
// (form → query def) + validation + the schema-derived option lists. Returned as ONE
// reactive object so the kind field-editors can bind to model.x directly. The function
// bodies are unchanged from the original single-file component; they close over the
// refs below, so only the *access* (model.x in templates) moved out of the SFC.
import { ref, computed, reactive, watch } from 'vue'
import { KIND_HINTS } from './constants'

export interface QueryBuilderProps { widget: any; schema: any }

export function useQueryModel(props: QueryBuilderProps) {
  const title = ref('')
  const kind = ref('stat')
  const about = ref('')
  const combinator = ref<'all' | 'any'>('all')
  const conditions = ref<any[]>([])
  const judgeCriteria = ref('')
  const judgeConfidence = ref(0.7)
  const tsEvents = ref<string[]>([])   // timeseries: event action(s)
  const tsAgg = ref('count')
  const grain = ref('week')
  const breakdownDim = ref('')         // 'channel' | 'session:utm_*' | 'attr:event' | 'fact:<key>'
  const breakdownValues = ref('')      // only for a fact dimension
  const breakdownMeasure = ref('people')
  const distSource = ref<'fact' | 'event'>('fact')   // distribution: bin a numeric fact, or an event's per-person count
  const distKey = ref('')              // the fact key or event action to bin
  const distBins = ref('')             // optional explicit bucket edges, comma-separated (else auto)
  const scatterX = ref('')             // scatter: numeric fact on the X axis
  const scatterY = ref('')             // scatter: numeric fact on the Y axis
  const scatterColor = ref('')         // scatter: optional categorical fact to colour dots by
  // compare (multi-series): split the base measure into several named series
  const compareOn = ref(false)
  const compareMode = ref<'split' | 'custom'>('split')
  const splitKey = ref('')             // fact key whose values become the series
  const splitVals = ref('')            // those values, comma-separated
  const customSeries = ref<any[]>([])  // [{ name, c }] — each series is a named cohort over the base
  const newSeries = () => ({ name: '', c: newCondition() })
  const stackMode = ref<'group' | 'stack' | 'pct'>('group')   // compare bars/area: grouped, stacked, or 100%
  const target = ref<number | null>(null)   // stat (KPI): an optional goal to show progress against
  const cohortEvent = ref('')          // cohort: the activity that defines a cohort (blank = any activity)
  const cohortGrain = ref('month')
  const cohortPeriods = ref(6)
  const question = ref('')
  const steps = ref<any[]>([])         // funnel stages, in order: { name, event }
  const newStep = () => ({ name: '', event: '' })

  // option lists from the discovered schema
  const factKeys = computed(() => (props.schema?.factKeys || []).map((k: any) => ({ label: k.key, value: k.key })))
  const eventOpts = computed(() => (props.schema?.events || []).map((e: string) => ({ label: e, value: e })))
  const campaignOpts = computed(() => (props.schema?.campaigns || []).map((c: string) => ({ label: c, value: c })))
  const breakdownDims = computed(() => [
    { label: 'Channel', value: 'channel' },
    { label: 'Acquisition source', value: 'session:utm_source' },
    { label: 'Campaign', value: 'session:utm_campaign' },
    { label: 'Event action', value: 'attr:event' },
    ...(props.schema?.attrKeys || []).map((k: string) => ({ label: 'Event · ' + k, value: 'attr:' + k })),
    ...factKeys.value.map((k: any) => ({ label: 'Fact · ' + k.label, value: 'fact:' + k.value })),
  ])
  const isFactDim = computed(() => breakdownDim.value.startsWith('fact:'))
  // donut + radar + pivot + heatmap share the breakdown builder (rows) — only the rendering differs.
  const isBreakdownLike = computed(() => ['breakdown', 'donut', 'radar', 'pivot', 'heatmap'].includes(kind.value))
  // per-kind wording for the shared breakdown UI (icon / verb / the noun for one bucket)
  const bdIcon = computed(() => ({ donut: 'pi pi-chart-pie ic', radar: 'pi pi-compass ic' }[kind.value] || 'pi pi-chart-bar ic'))
  const bdVerb = computed(() => ({ donut: 'Slice by', radar: 'Axis by' }[kind.value] || 'Break down by'))
  const bdUnit = computed(() => ({ donut: 'slice', radar: 'axis' }[kind.value] || 'bar'))
  // distribution over a fact needs a NUMERIC fact; over an event it picks an event action.
  const numericFactKeys = computed(() => (props.schema?.factKeys || [])
    .filter((k: any) => (k.sample || []).length && k.sample.every((v: any) => v !== '' && v != null && !isNaN(Number(v))))
    .map((k: any) => ({ label: k.key, value: k.key })))
  const distKeyOpts = computed(() => (distSource.value === 'event' ? eventOpts.value : numericFactKeys.value))
  // compare (overlay several series) applies to shared-axis measures + the 2-D grids
  // (pivot/heatmap), where the compare series become the matrix columns
  const canCompare = computed(() => ['timeseries', 'breakdown', 'radar', 'stat', 'pivot', 'heatmap'].includes(kind.value))
  // stacking applies to bars (breakdown) and area (timeseries), not radar/stat
  const canStack = computed(() => compareOn.value && ['breakdown', 'timeseries'].includes(kind.value))
  const kindHint = computed(() => KIND_HINTS[kind.value] || '')

  const newCondition = () => ({ not: false, type: 'fact', key: factKeys.value[0]?.value || '', op: 'eq', value: '', events: [], campaigns: [], measure: 'count', cmp: 'gte', mvalue: '1', window: '' })

  // ── dirtiness (regenerate the summary only when the query changed) ──────────────
  let originalQuery = ''
  const stableStr = (o: any): string =>
    o === null || typeof o !== 'object' ? JSON.stringify(o)
      : Array.isArray(o) ? '[' + o.map(stableStr).join(',') + ']'
        : '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stableStr(o[k])).join(',') + '}'
  function captureOriginal() { originalQuery = stableStr(build()) }
  function isDirty() { return stableStr(build()) !== originalQuery }

  const coerceScalar = (v: string): any => {
    if (v === 'true') return true
    if (v === 'false') return false
    if (v !== '' && !isNaN(Number(v))) return Number(v)
    return v
  }
  const eventArr = (ev: any): string[] => ev == null ? [] : (ev.in ? ev.in : Array.isArray(ev) ? ev : [ev])

  // ── parse: query def → form ────────────────────────────────────────────────────
  function parseClause(cl: any): any | null {
    let not = false
    if (cl?.not) { not = true; cl = cl.not }
    if (cl?.fact) {
      const key = Object.keys(cl.fact)[0]; const op = Object.keys(cl.fact[key])[0]
      const v = cl.fact[key][op]
      return { ...newCondition(), not, type: 'fact', key, op, value: Array.isArray(v) ? v.join(', ') : String(v) }
    }
    if (cl?.metric) {
      const m = cl.metric
      const measure = m.sum ? 'sum' : 'count'
      const agg = m.sum || m.count || {}
      const cmp = agg.lte !== undefined ? 'lte' : 'gte'
      const mvalue = agg.gte ?? agg.lte ?? ''
      const camp = m.session?.utm_campaign
      return { ...newCondition(), not, type: 'metric', events: eventArr(m.attrs?.event),
        campaigns: camp == null ? [] : (Array.isArray(camp) ? camp : [camp]), measure, cmp, mvalue: String(mvalue), window: m.last || '' }
    }
    return null
  }

  function parse(w: any) {
    title.value = w.title || ''
    kind.value = w.kind || 'stat'
    const q = w.query || {}
    // a custom-series compare stores the base measure inside each series' query — read
    // the kind fields from the first series' query (bq); read the compare config from q.
    const bq = (Array.isArray(q.series) && q.series[0]?.query) ? q.series[0].query : q
    about.value = bq.selector?.about || ''
    combinator.value = 'all'; conditions.value = []
    judgeCriteria.value = bq.selector?.judge?.criteria || ''
    judgeConfidence.value = bq.selector?.judge?.confidence ?? 0.7
    tsEvents.value = []; tsAgg.value = 'count'; grain.value = 'week'
    breakdownDim.value = ''; breakdownValues.value = ''; breakdownMeasure.value = 'people'
    distSource.value = 'fact'; distKey.value = ''; distBins.value = ''
    scatterX.value = ''; scatterY.value = ''; scatterColor.value = ''
    compareOn.value = false; compareMode.value = 'split'; splitKey.value = ''; splitVals.value = ''; customSeries.value = []; stackMode.value = 'group'; target.value = null
    cohortEvent.value = ''; cohortGrain.value = 'month'; cohortPeriods.value = 6
    question.value = ''; steps.value = []

    if (kind.value === 'answer') question.value = bq.question || ''
    else if (kind.value === 'funnel' || kind.value === 'dropoff') {
      steps.value = (bq.funnel?.steps || []).map((s: any) => {
        const e = s.select?.filter?.metric?.attrs?.event
        return { name: s.name || '', event: typeof e === 'string' ? e : '' }
      })
    } else if (kind.value === 'timeseries') {
      const m = bq.selector?.filter?.metric || {}
      tsEvents.value = eventArr(m.attrs?.event); tsAgg.value = m.sum ? 'sum' : 'count'; grain.value = bq.group?.by || 'week'
    } else if (kind.value === 'distribution') {
      const dd = bq.distribution || {}
      distSource.value = dd.source === 'event' ? 'event' : 'fact'
      distKey.value = dd.key || ''
      distBins.value = Array.isArray(dd.bins) ? dd.bins.join(', ') : ''
    } else if (kind.value === 'scatter') {
      const sc = bq.scatter || {}
      scatterX.value = sc.x || ''; scatterY.value = sc.y || ''; scatterColor.value = sc.colorBy || ''
    } else if (kind.value === 'cohort') {
      const co = bq.cohort || {}
      cohortEvent.value = co.event || ''; cohortGrain.value = co.grain || 'month'; cohortPeriods.value = co.periods || 6
    } else if (isBreakdownLike.value) {
      if (bq.breakdownFact) { breakdownDim.value = 'fact:' + bq.breakdownFact.key; breakdownValues.value = (bq.breakdownFact.values || []).join(', ') }
      else if (bq.group?.by) { breakdownDim.value = bq.group.by; breakdownMeasure.value = bq.selector?.filter?.metric?.distinct_passports ? 'people' : 'events' }
    } else {
      const f = bq.selector?.filter
      let clauses: any[] = []
      if (f?.all) { clauses = f.all; combinator.value = 'all' }
      else if (f?.any) { clauses = f.any; combinator.value = 'any' }
      else if (f) clauses = [f]
      conditions.value = clauses.map(parseClause).filter(Boolean)
    }

    // compare config (splitBy sugar, or explicit named series)
    if (q.splitBy?.key) {
      compareOn.value = true; compareMode.value = 'split'
      splitKey.value = q.splitBy.key; splitVals.value = (q.splitBy.values || []).join(', ')
    } else if (Array.isArray(q.series) && q.series.length) {
      compareOn.value = true; compareMode.value = 'custom'
      customSeries.value = q.series.map((s: any) => ({ name: s.name || '', c: parseClause(s.query?.scope?.filter) || newCondition() }))
    }
    stackMode.value = q.stack || 'group'
    target.value = typeof bq.target === 'number' ? bq.target : null
    captureOriginal()
  }

  function reset() {
    title.value = ''; kind.value = 'stat'; about.value = ''
    combinator.value = 'all'; conditions.value = []; judgeCriteria.value = ''; judgeConfidence.value = 0.7
    tsEvents.value = []; tsAgg.value = 'count'; grain.value = 'week'
    breakdownDim.value = ''; breakdownValues.value = ''; breakdownMeasure.value = 'people'
    distSource.value = 'fact'; distKey.value = ''; distBins.value = ''
    scatterX.value = ''; scatterY.value = ''; scatterColor.value = ''
    compareOn.value = false; compareMode.value = 'split'; splitKey.value = ''; splitVals.value = ''; customSeries.value = []; stackMode.value = 'group'; target.value = null
    cohortEvent.value = ''; cohortGrain.value = 'month'; cohortPeriods.value = 6
    question.value = ''; steps.value = []
    captureOriginal()
  }
  function addSeries() { customSeries.value.push(newSeries()) }
  function removeSeries(i: number) { customSeries.value.splice(i, 1) }

  // ── build: form → query def ────────────────────────────────────────────────────
  function eventClause(events: string[]) { return events.length === 1 ? events[0] : { in: events } }

  function buildClause(c: any): any {
    let cl: any
    if (c.type === 'metric') {
      const m: any = {}
      if (c.events?.length) m.attrs = { event: eventClause(c.events) }
      if (c.campaigns?.length) m.session = { utm_campaign: c.campaigns.length === 1 ? c.campaigns[0] : c.campaigns }
      const bound = { [c.cmp]: coerceScalar(c.mvalue) }
      if (c.measure === 'sum') m.sum = { field: 'value', ...bound }; else m.count = bound
      if (c.window) m.last = c.window
      cl = { metric: m }
    } else {
      const val = c.op === 'present' ? true
        : c.op === 'in' ? c.value.split(',').map((s: string) => coerceScalar(s.trim()))
          : coerceScalar(c.value)
      cl = { fact: { [c.key]: { [c.op]: val } } }
    }
    return c.not ? { not: cl } : cl
  }

  function buildBase(): any {
    if (kind.value === 'answer') return { question: question.value }
    if (kind.value === 'cohort') return { cohort: { ...(cohortEvent.value ? { event: cohortEvent.value } : {}), grain: cohortGrain.value, periods: Number(cohortPeriods.value) || 6 } }
    if (kind.value === 'distribution') {
      const d: any = { source: distSource.value, key: distKey.value }
      const edges = distBins.value.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n))
      if (edges.length >= 2) d.bins = edges.sort((a, b) => a - b)
      return { distribution: d }
    }
    if (kind.value === 'scatter') {
      const s: any = { x: scatterX.value, y: scatterY.value }
      if (scatterColor.value) s.colorBy = scatterColor.value
      return { scatter: s }
    }
    if (isBreakdownLike.value) {   // breakdown + donut: identical query, different chart
      if (isFactDim.value) {
        return { breakdownFact: { key: breakdownDim.value.slice(5), values: breakdownValues.value.split(',').map((s) => coerceScalar(s.trim())).filter((v: any) => v !== '') } }
      }
      const metric: any = breakdownMeasure.value === 'events' ? { count: {} } : { distinct_passports: {} }
      // session dimensions: restrict to known values so a null bucket doesn't dominate
      if (breakdownDim.value === 'session:utm_campaign') metric.session = { utm_campaign: props.schema?.campaigns || [] }
      else if (breakdownDim.value === 'session:utm_source') metric.session = { utm_source: props.schema?.sources || [] }
      return { selector: { filter: { metric } }, group: { by: breakdownDim.value } }
    }
    if (kind.value === 'timeseries') {
      const ev = tsEvents.value.length ? { attrs: { event: eventClause(tsEvents.value) } } : {}
      const agg = tsAgg.value === 'sum' ? { sum: { field: 'value' } } : { count: {} }
      return { selector: { filter: { metric: { ...ev, ...agg } } }, projection: 'knowledge', group: { by: grain.value } }
    }
    if (kind.value === 'funnel' || kind.value === 'dropoff') {
      return { funnel: { steps: steps.value.filter((s) => s.event).map((s) => ({
        ...(s.name.trim() ? { name: s.name.trim() } : {}),
        select: { filter: { metric: { attrs: { event: s.event }, count: { gte: 1 } } } },
      })) } }
    }
    // stat / table → people, full selector
    const clauses = conditions.value.filter((c) => (c.type === 'metric' ? (c.events.length || c.campaigns.length) : c.key)).map(buildClause)
    const filter = clauses.length === 0 ? undefined : clauses.length === 1 ? clauses[0] : { [combinator.value]: clauses }
    const selector: any = {}
    if (about.value.trim()) selector.about = about.value.trim()
    if (filter) selector.filter = filter
    if (judgeCriteria.value.trim()) selector.judge = { criteria: judgeCriteria.value.trim(), confidence: Number(judgeConfidence.value) || 0.7 }
    const out: any = { selector, projection: 'people' }
    if (kind.value === 'stat' && target.value) out.target = target.value   // KPI goal
    return out
  }

  // Wrap the base measure with a comparison when "Compare" is on: splitBy a fact's
  // values, or an explicit list of named cohort series (each = base + that scope).
  function build(): any {
    const base = buildBase()
    if (!canCompare.value || !compareOn.value) return base
    let out: any = base
    if (compareMode.value === 'split') {
      const values = splitVals.value.split(',').map((s) => coerceScalar(s.trim())).filter((v: any) => v !== '')
      if (splitKey.value && values.length) out = { ...base, splitBy: { key: splitKey.value, values } }
    } else {
      const valid = customSeries.value.filter((s) => (s.c.type === 'metric' ? (s.c.events.length || s.c.campaigns.length) : s.c.key))
      if (valid.length) out = { series: valid.map((s, i) => ({
        name: (s.name || '').trim() || `Series ${i + 1}`,
        query: { ...base, scope: { filter: buildClause(s.c) } },
      })) }
    }
    // stack mode is a presentation hint on bars/area comparisons
    if (out !== base && stackMode.value !== 'group' && ['breakdown', 'timeseries'].includes(kind.value)) out.stack = stackMode.value
    return out
  }

  function baseHasContent() {
    if (kind.value === 'answer') return !!question.value.trim()
    if (kind.value === 'cohort') return true   // a cohort over any activity is valid
    if (kind.value === 'distribution') return !!distKey.value
    if (kind.value === 'scatter') return !!scatterX.value && !!scatterY.value
    if (isBreakdownLike.value) return !!breakdownDim.value && (!isFactDim.value || !!breakdownValues.value)
    if (kind.value === 'timeseries') return tsEvents.value.length > 0
    if (kind.value === 'funnel' || kind.value === 'dropoff') return steps.value.some((s) => s.event)
    return !!about.value.trim() || !!judgeCriteria.value.trim() || conditions.value.some((c) => (c.type === 'metric' ? (c.events.length || c.campaigns.length) : c.key))
  }
  function compareHasContent() {
    return compareMode.value === 'split'
      ? (!!splitKey.value && !!splitVals.value.trim())
      : customSeries.value.some((s) => (s.c.type === 'metric' ? (s.c.events.length || s.c.campaigns.length) : s.c.key))
  }
  function hasContent() {
    if (canCompare.value && compareOn.value) {
      // a stat compare just counts people per series, so the base needs no measure; the others do
      return compareHasContent() && (kind.value === 'stat' || baseHasContent())
    }
    return baseHasContent()
  }
  function addCondition() { conditions.value.push(newCondition()) }
  function removeCondition(i: number) { conditions.value.splice(i, 1) }
  function addStep() { steps.value.push(newStep()) }
  function removeStep(i: number) { steps.value.splice(i, 1) }

  watch(() => props.widget?.id, () => (props.widget ? parse(props.widget) : reset()), { immediate: true })

  // One reactive object: nested refs/computeds are auto-unwrapped on access (model.x),
  // so children bind v-model="model.x" and the writes flow back to the refs above.
  return reactive({
    // state
    title, kind, about, combinator, conditions, judgeCriteria, judgeConfidence,
    tsEvents, tsAgg, grain, breakdownDim, breakdownValues, breakdownMeasure,
    distSource, distKey, distBins, scatterX, scatterY, scatterColor,
    compareOn, compareMode, splitKey, splitVals, customSeries, stackMode, target,
    cohortEvent, cohortGrain, cohortPeriods, question, steps,
    // option lists / derived
    factKeys, eventOpts, campaignOpts, breakdownDims, numericFactKeys, distKeyOpts,
    isFactDim, isBreakdownLike, bdIcon, bdVerb, bdUnit, canCompare, canStack, kindHint,
    // actions
    parse, reset, build, hasContent, isDirty, captureOriginal,
    addCondition, removeCondition, addStep, removeStep, addSeries, removeSeries,
  })
}

export type QueryModel = ReturnType<typeof useQueryModel>
