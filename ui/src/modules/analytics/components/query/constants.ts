// Static option lists + per-kind hints for the Query builder. Pulled out of the
// component so the kind field-editors and the model can share one source of truth.

export const KINDS = [
  { value: 'stat', label: 'Number', icon: 'pi pi-hashtag' },
  { value: 'table', label: 'List', icon: 'pi pi-list' },
  { value: 'timeseries', label: 'Trend', icon: 'pi pi-chart-line' },
  { value: 'breakdown', label: 'Breakdown', icon: 'pi pi-chart-bar' },
  { value: 'donut', label: 'Donut', icon: 'pi pi-chart-pie' },
  { value: 'radar', label: 'Radar', icon: 'pi pi-compass' },
  { value: 'distribution', label: 'Distribution', icon: 'pi pi-objects-column' },
  { value: 'scatter', label: 'Scatter', icon: 'pi pi-chart-scatter' },
  { value: 'pivot', label: 'Pivot', icon: 'pi pi-table' },
  { value: 'heatmap', label: 'Heatmap', icon: 'pi pi-th-large' },
  { value: 'cohort', label: 'Cohort', icon: 'pi pi-calendar' },
  { value: 'funnel', label: 'Funnel', icon: 'pi pi-filter' },
  { value: 'dropoff', label: 'Drop-off', icon: 'pi pi-filter-slash' },
  { value: 'answer', label: 'Answer', icon: 'pi pi-comment' },
]

export const COHORT_GRAINS = [{ label: 'Monthly', value: 'month' }, { label: 'Weekly', value: 'week' }]
export const DIST_SOURCES = [{ label: 'A numeric fact', value: 'fact' }, { label: 'An event count', value: 'event' }]
export const OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'present'].map((o) => ({ label: o, value: o }))
export const GRAINS = [{ label: 'Day', value: 'day' }, { label: 'Week', value: 'week' }, { label: 'Month', value: 'month' }]
export const AGGS = [{ label: 'Count', value: 'count' }, { label: 'Sum of value', value: 'sum' }]
export const CLAUSE_TYPES = [{ label: 'Fact', value: 'fact' }, { label: 'Activity', value: 'metric' }]
export const MEASURES = [{ label: 'count', value: 'count' }, { label: 'sum', value: 'sum' }]
export const CMPS = [{ label: '≥', value: 'gte' }, { label: '≤', value: 'lte' }]
export const COMBINATORS = [{ label: 'all', value: 'all' }, { label: 'any', value: 'any' }]
export const MEASURE2 = [{ label: 'People', value: 'people' }, { label: 'Events', value: 'events' }]

export const KIND_HINTS: Record<string, string> = {
  stat: 'A single number — how many people match the conditions below.',
  table: 'A list of the people who match, with their identity.',
  timeseries: 'A line over time — an event counted per period.',
  breakdown: 'One bar per value of a dimension (channel, campaign, source, event) or fact.',
  donut: 'Share of total — the same split as a breakdown, drawn as a ring.',
  radar: 'A profile across dimensions — the same split as a breakdown, drawn as a polygon. Best with 3+ comparable buckets.',
  distribution: 'A histogram — how a numeric fact, or an event count, spreads across people.',
  scatter: 'One dot per person on two numeric facts — reveals a relationship (e.g. value vs visits).',
  pivot: 'A table crossing two dimensions — break down by rows, compare across columns.',
  heatmap: 'A colour grid crossing two dimensions — darker = higher. Break down by rows, compare across columns.',
  cohort: 'Retention by cohort — each row is a start period, columns track how many stay active over time.',
  funnel: 'Ordered stages — how many people reach each step.',
  dropoff: 'The negative funnel — how many people are LOST between each step (your re-engagement audiences).',
  answer: 'A short written answer, generated from customer memory.',
}
