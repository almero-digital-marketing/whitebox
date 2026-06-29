<script setup lang="ts">
// Funnel — ECharts' dedicated funnel series: trapezoid slices sized by value, labelled
// with the step name + count. No axes/grid.
import { computed } from 'vue'
import BaseChart from './BaseChart.vue'
import { readTheme } from './theme'
const props = defineProps<{ points: any[]; selectedIndex?: number | null }>()
const emit = defineEmits<{ select: [sel: any] }>()
defineOptions({ inheritAttrs: false })
const { C, PALETTE } = readTheme()
// a step → a segment of that step's completers (funnel slot "step:N", 1-based)
function onClick(p: any) {
  if (p?.dataIndex == null) return
  emit('select', { kind: 'funnel', index: p.dataIndex, name: p.name })
}
const option = computed(() => {
  const sel = props.selectedIndex
  return {
    tooltip: { trigger: 'item', formatter: '{b}: {c}' },
    color: PALETTE,
    series: [{
      type: 'funnel',
      top: 12, bottom: 12, left: '6%', width: '88%',
      sort: 'none', gap: 2, minSize: '24%',   // keep DEFINED step order — slice position == step index == slot
      funnelAlign: 'center',
      label: { show: true, position: 'inside', color: '#fff', fontSize: 11, fontWeight: 600, formatter: '{b}\n{c}' },
      labelLine: { show: false },
      itemStyle: { borderColor: C.panel, borderWidth: 2 },
      emphasis: { label: { fontSize: 12 } },
      data: props.points.map((p, i) => ({ name: p.bucket, value: p.value, itemStyle: { color: PALETTE[i % PALETTE.length], opacity: sel == null || sel === i ? 1 : 0.18 } })),
    }],
  }
})
</script>

<template><BaseChart :option="option" @chart-click="onClick" /></template>
