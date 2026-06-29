<script setup lang="ts">
// Cartesian — the single-series bar/line family: breakdown + distribution are categorical
// bars (distribution = a contiguous histogram of one variable, one colour), timeseries is
// a smooth line with a soft area fill.
import { computed } from 'vue'
import BaseChart from './BaseChart.vue'
import { readTheme } from './theme'
const props = defineProps<{ kind: string; points: any[]; selectedIndex?: number | null }>()
const emit = defineEmits<{ select: [sel: any] }>()
defineOptions({ inheritAttrs: false })
const { C, PALETTE } = readTheme()
const isBar = computed(() => props.kind === 'breakdown' || props.kind === 'distribution')
const isDist = computed(() => props.kind === 'distribution')
// a bar → a segment. breakdown = the bucket value; distribution = the bin's numeric
// range (lo/hi carried on the point). timeseries (a line) isn't selectable.
function onClick(p: any) {
  if (p?.dataIndex == null) return
  const pt = props.points[p.dataIndex]
  if (props.kind === 'breakdown') emit('select', { kind: 'breakdown', bucket: p.name, index: p.dataIndex })
  else if (props.kind === 'distribution') emit('select', { kind: 'distribution', bucket: p.name, index: p.dataIndex, lo: pt?.lo, hi: pt?.hi, last: p.dataIndex === props.points.length - 1 })
}
const option = computed(() => {
  const cats = props.points.map((p) => p.bucket)
  // a breakdown/distribution must show EVERY bar's label; rotate when many/long so they
  // don't overlap (a line keeps auto-thinning its labels).
  const longest = Math.max(0, ...cats.map((c) => String(c).length))
  const rotate = isBar.value && (cats.length > 5 || longest > 9) ? 30 : 0
  return {
  grid: { left: 40, right: 14, top: 16, bottom: rotate ? 50 : 30 },
  tooltip: { trigger: 'axis' },
  xAxis: {
    type: 'category',
    data: cats,
    axisLabel: { color: C.muted, fontSize: 10, interval: isBar.value ? 0 : 'auto', hideOverlap: !isBar.value, rotate },
    axisLine: { lineStyle: { color: C.border } },
  },
  yAxis: {
    type: 'value',
    axisLabel: { color: C.muted, fontSize: 10 },
    splitLine: { lineStyle: { color: C.grid } },
  },
  color: PALETTE,
  series: [{
    type: isBar.value ? 'bar' : 'line',
    // breakdown: each category a palette color. distribution: one colour (a histogram of
    // one variable). line: a single accent color.
    data: isBar.value
      ? props.points.map((p, i) => ({ value: p.value, itemStyle: { color: isDist.value ? PALETTE[0] : PALETTE[i % PALETTE.length], borderRadius: [3, 3, 0, 0], opacity: props.selectedIndex == null || props.selectedIndex === i ? 1 : 0.18 } }))
      : props.points.map((p) => p.value),
    smooth: !isBar.value,
    showSymbol: props.points.length <= 40,   // markers visible so a lone point isn't an invisible (empty-looking) line
    symbolSize: 6,
    barWidth: isDist.value ? '96%' : '60%',   // contiguous bars → histogram
    lineStyle: isBar.value ? undefined : { color: PALETTE[0], width: 2 },
    itemStyle: isBar.value ? undefined : { color: PALETTE[0] },
    areaStyle: isBar.value ? undefined : { color: PALETTE[0], opacity: 0.12 },
  }],
  }
})
</script>

<template><BaseChart :option="option" @chart-click="onClick" /></template>
