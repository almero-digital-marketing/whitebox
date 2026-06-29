<script setup lang="ts">
// Heatmap (also cohort) — the compare matrix as a colour grid: x = columns (series),
// y = rows (buckets), cell colour = value (light → accent). Cells labelled.
import { computed } from 'vue'
import BaseChart from './BaseChart.vue'
import { readTheme, alignSeries } from './theme'
const props = defineProps<{ multi: any }>()
defineOptions({ inheritAttrs: false })
const { C, PALETTE } = readTheme()
const option = computed(() => {
  const { axis, series } = alignSeries(props.multi?.series || [])   // axis = rows, series = columns
  const rows = axis
  const cols = series.map((s) => s.name)
  const pct = props.multi?.unit === '%'
  const data: any[] = []
  let maxV = 0
  series.forEach((s, ci) => s.values.forEach((v, ri) => { data.push([ci, ri, v]); if (v > maxV) maxV = v }))
  return {
    grid: { left: 76, right: 12, top: 10, bottom: 30, containLabel: false },
    tooltip: { position: 'top', formatter: (p: any) => `${rows[p.value[1]]} · ${cols[p.value[0]]}: ${p.value[2]}${pct ? '%' : ''}` },
    xAxis: { type: 'category', data: cols, axisLabel: { color: C.muted, fontSize: 10, hideOverlap: true }, axisLine: { show: false }, axisTick: { show: false } },
    yAxis: { type: 'category', data: rows, inverse: true, axisLabel: { color: C.muted, fontSize: 10 }, axisLine: { show: false }, axisTick: { show: false } },
    visualMap: { show: false, min: 0, max: pct ? 100 : Math.max(1, maxV), inRange: { color: [C.grid, PALETTE[0]] } },
    series: [{
      type: 'heatmap', data,
      label: {
        show: rows.length * cols.length <= 70, fontSize: 10,
        formatter: (p: any) => `${p.value[2]}${pct ? '%' : ''}`,
        color: (p: any) => (p.value[2] >= (pct ? 50 : Math.max(1, maxV) * 0.5) ? '#fff' : C.muted),   // contrast on dark vs light cells
      },
      itemStyle: { borderColor: C.panel, borderWidth: 2, borderRadius: 3 },
      emphasis: { itemStyle: { borderColor: C.muted } },
    }],
  }
})
</script>

<template><BaseChart :option="option" /></template>
