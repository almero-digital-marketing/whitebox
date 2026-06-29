<script setup lang="ts">
// Picks the chart for a widget's data and renders it. Each chart kind is a self-
// contained component under ./charts (its own ECharts option); the shared theme/palette
// and the mount-when-sized renderer (BaseChart) live there too. Selection factors in
// whether the data is a multi-series compare, not just the kind.
import { computed } from 'vue'
import Funnel from './charts/Funnel.vue'
import Dropoff from './charts/Dropoff.vue'
import Donut from './charts/Donut.vue'
import Radar from './charts/Radar.vue'
import Scatter from './charts/Scatter.vue'
import Cartesian from './charts/Cartesian.vue'
import MultiCartesian from './charts/MultiCartesian.vue'
import MultiRadar from './charts/MultiRadar.vue'
import Heatmap from './charts/Heatmap.vue'

// points: {bucket,value}[] for most kinds; {x,y,id,group?}[] for scatter. axes: scatter axis labels.
// multi: a compare result — several named series sharing a bucket axis (multi-line / grouped bar / overlaid radar).
const props = defineProps<{
  kind: string
  points: any[]
  axes?: { x?: string; y?: string }
  multi?: { series: { name: string; points: { bucket: string; value: number }[] }[]; unit?: string; cohort?: boolean } | null
  stack?: 'group' | 'stack' | 'pct'   // multi bars/area: grouped (default), stacked, or 100%-stacked
  selectedIndex?: number | null       // single-series: the element kept highlighted while its chip is open
  selectedMulti?: { bucket: string; series: string } | null   // multi-series: the (bucket × series) bar kept lit
}>()

defineEmits<{ select: [sel: any] }>()
const isMulti = computed(() => !!props.multi?.series?.length)
const chart = computed(() => {
  const k = props.kind
  if (k === 'heatmap' || k === 'cohort') return Heatmap          // 2-D grid (always a compare matrix)
  if (isMulti.value) return k === 'radar' ? MultiRadar : MultiCartesian
  if (k === 'dropoff') return Dropoff
  if (k === 'funnel') return Funnel
  if (k === 'donut') return Donut
  if (k === 'radar') return Radar
  if (k === 'scatter') return Scatter
  return Cartesian                                               // breakdown / distribution / timeseries
})
</script>

<template>
  <component :is="chart" v-bind="props" @select="$emit('select', $event)" />
</template>
