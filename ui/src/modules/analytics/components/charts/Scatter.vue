<script setup lang="ts">
// Scatter — one dot per person at (x, y), two numeric facts. When points carry a
// `group` (colorBy), split into one series per group with a legend; else a single
// series. Axis names come from the fact keys.
import { computed } from 'vue'
import BaseChart from './BaseChart.vue'
import { readTheme, nfmt } from './theme'
const props = defineProps<{ points: any[]; axes?: { x?: string; y?: string } }>()
defineOptions({ inheritAttrs: false })
const { C, PALETTE } = readTheme()
const option = computed(() => {
  const xName = props.axes?.x || 'x'
  const yName = props.axes?.y || 'y'
  const pts = props.points
  const hasGroups = pts.some((p) => p.group != null)
  const dot = (p: any) => ({ value: [p.x, p.y], id: p.id })
  let series: any[]
  if (hasGroups) {
    const groups = [...new Set(pts.map((p) => (p.group ?? '—')))]
    series = groups.map((g, i) => ({
      name: String(g), type: 'scatter', symbolSize: 8,
      itemStyle: { color: PALETTE[i % PALETTE.length], opacity: 0.75 },
      data: pts.filter((p) => (p.group ?? '—') === g).map(dot),
    }))
  } else {
    series = [{ type: 'scatter', symbolSize: 8, itemStyle: { color: PALETTE[0], opacity: 0.7 }, data: pts.map(dot) }]
  }
  return {
    grid: { left: 52, right: 16, top: hasGroups ? 28 : 14, bottom: 38 },
    legend: hasGroups ? { top: 0, icon: 'circle', itemHeight: 8, itemWidth: 8, textStyle: { color: C.muted, fontSize: 11 } } : undefined,
    tooltip: { trigger: 'item', formatter: (p: any) => `${xName}: ${nfmt(p.value[0])}<br/>${yName}: ${nfmt(p.value[1])}` },
    xAxis: {
      type: 'value', name: xName, nameLocation: 'middle', nameGap: 24, nameTextStyle: { color: C.muted, fontSize: 11 },
      axisLabel: { color: C.muted, fontSize: 10 }, axisLine: { lineStyle: { color: C.border } }, splitLine: { lineStyle: { color: C.grid } },
    },
    yAxis: {
      type: 'value', name: yName, nameLocation: 'middle', nameGap: 38, nameTextStyle: { color: C.muted, fontSize: 11 },
      axisLabel: { color: C.muted, fontSize: 10 }, splitLine: { lineStyle: { color: C.grid } },
    },
    series,
  }
})
</script>

<template><BaseChart :option="option" /></template>
