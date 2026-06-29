<script setup lang="ts">
// Overlaid radar — one polygon per series over the shared axes (shared max scale).
import { computed } from 'vue'
import BaseChart from './BaseChart.vue'
import { readTheme, legendBase, alignSeries } from './theme'
const props = defineProps<{ multi: any }>()
defineOptions({ inheritAttrs: false })
const { C, PALETTE } = readTheme()
const option = computed(() => {
  const { axis, series } = alignSeries(props.multi?.series || [])
  const max = Math.max(1, ...series.flatMap((s) => s.values))
  return {
    tooltip: { trigger: 'item' },
    legend: legendBase(C),
    radar: {
      indicator: axis.map((name) => ({ name, max })),
      center: ['50%', '56%'], radius: '60%', splitNumber: 4,
      axisName: { color: C.muted, fontSize: 11 }, splitLine: { lineStyle: { color: C.grid } },
      splitArea: { show: false }, axisLine: { lineStyle: { color: C.grid } },
    },
    series: [{
      type: 'radar', symbolSize: 4,
      data: series.map((s, i) => ({
        name: s.name, value: s.values,
        lineStyle: { color: PALETTE[i % PALETTE.length], width: 2 },
        itemStyle: { color: PALETTE[i % PALETTE.length] },
        areaStyle: { color: PALETTE[i % PALETTE.length], opacity: 0.1 },
      })),
    }],
  }
})
</script>

<template><BaseChart :option="option" /></template>
