<script setup lang="ts">
// Donut — share of total. Pie with an inner radius; slices labelled name + percent.
import { computed } from 'vue'
import BaseChart from './BaseChart.vue'
import { readTheme } from './theme'
const props = defineProps<{ points: any[]; selectedIndex?: number | null }>()
const emit = defineEmits<{ select: [sel: any] }>()
defineOptions({ inheritAttrs: false })
const { C, PALETTE } = readTheme()
// a slice → a segment (the slice's bucket value)
function onClick(p: any) {
  if (p?.dataIndex == null) return
  emit('select', { kind: 'donut', bucket: p.name, index: p.dataIndex })
}
const option = computed(() => {
  const sel = props.selectedIndex
  return {
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    color: PALETTE,
    series: [{
      type: 'pie',
      radius: ['46%', '72%'], center: ['50%', '50%'], avoidLabelOverlap: true,
      itemStyle: { borderColor: C.panel, borderWidth: 2 },
      label: { show: true, color: C.muted, fontSize: 11, formatter: '{b}  {d}%' },
      labelLine: { length: 10, length2: 8, lineStyle: { color: C.border } },
      data: props.points.map((p, i) => ({ name: p.bucket, value: p.value, itemStyle: { color: PALETTE[i % PALETTE.length], opacity: sel == null || sel === i ? 1 : 0.18 } })),
    }],
  }
})
</script>

<template><BaseChart :option="option" @chart-click="onClick" /></template>
