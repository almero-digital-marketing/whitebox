<script setup lang="ts">
// Radar — one polygon over shared axes: each bucket becomes an indicator (axis), the
// single series traces its values. A shared max keeps the axes comparable.
import { computed } from 'vue'
import BaseChart from './BaseChart.vue'
import { readTheme } from './theme'
const props = defineProps<{ points: any[] }>()
defineOptions({ inheritAttrs: false })
const { C, PALETTE } = readTheme()
const option = computed(() => {
  const vals = props.points.map((p) => p.value)
  const max = Math.max(...vals, 1)
  return {
    tooltip: { trigger: 'item' },
    radar: {
      indicator: props.points.map((p) => ({ name: p.bucket, max })),
      center: ['50%', '55%'], radius: '64%', splitNumber: 4,
      axisName: { color: C.muted, fontSize: 11 },
      splitLine: { lineStyle: { color: C.grid } },
      splitArea: { show: false },
      axisLine: { lineStyle: { color: C.grid } },
    },
    series: [{
      type: 'radar', symbolSize: 4,
      data: [{
        value: vals,
        lineStyle: { color: PALETTE[0], width: 2 },
        itemStyle: { color: PALETTE[0] },
        areaStyle: { color: PALETTE[0], opacity: 0.18 },
      }],
    }],
  }
})
</script>

<template><BaseChart :option="option" /></template>
