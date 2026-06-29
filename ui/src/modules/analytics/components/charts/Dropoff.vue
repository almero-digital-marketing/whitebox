<script setup lang="ts">
// Drop-off ("negative funnel") — the mirror of a funnel. One horizontal bar per step
// transition, sized by the people LOST there (count[i] − count[i+1]), labelled with the
// count + the % of that step who abandoned. These lost cohorts are the re-engagement
// audiences. Reads as the complement of the funnel widget.
import { computed } from 'vue'
import BaseChart from './BaseChart.vue'
import { readTheme, css } from './theme'
const props = defineProps<{ points: any[]; selectedIndex?: number | null }>()
// select carries the transition the user clicked: index i = the bar between funnel
// steps i and i+1, with the two step labels — enough for WidgetCard to derive the
// funnel-slot segment source (gap:i+1→i+2). See WidgetCard.onChartSelect.
const emit = defineEmits<{ select: [sel: { kind: 'dropoff'; index: number; from: string; to: string }] }>()
defineOptions({ inheritAttrs: false })
const { C } = readTheme()
function onClick(p: any) {
  const i = p?.dataIndex
  if (i == null) return
  const pts = props.points || []
  emit('select', { kind: 'dropoff', index: i, from: pts[i]?.bucket, to: pts[i + 1]?.bucket })
}
const option = computed(() => {
  const pts = props.points || []
  const sel = props.selectedIndex
  const rows: { label: string; lost: number; pct: number; from: number }[] = []
  for (let i = 0; i < pts.length - 1; i++) {
    const from = pts[i].value || 0
    const lost = Math.max(0, from - (pts[i + 1].value || 0))
    rows.push({ label: `${pts[i].bucket} → ${pts[i + 1].bucket}`, lost, pct: from ? Math.round((lost / from) * 100) : 0, from })
  }
  const loss = css('--p-rose-500', '#f43f5e')
  return {
    grid: { left: 8, right: 64, top: 8, bottom: 8, containLabel: true },
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'shadow' },
      backgroundColor: C.panel, borderColor: C.border, textStyle: { color: C.muted, fontSize: 11 },
      formatter: (ps: any) => { const r = rows[ps[0].dataIndex]; return `${r.label}<br/><b>${r.lost.toLocaleString()}</b> lost · ${r.pct}% of ${r.from.toLocaleString()}` },
    },
    xAxis: { type: 'value', axisLabel: { color: C.muted, fontSize: 11 }, splitLine: { lineStyle: { color: C.grid } } },
    yAxis: {
      type: 'category', inverse: true, data: rows.map((r) => r.label),
      axisLabel: { color: C.muted, fontSize: 11 }, axisLine: { lineStyle: { color: C.border } }, axisTick: { show: false },
    },
    series: [{
      type: 'bar', barWidth: '54%',
      // a selection (segment chip open) keeps its bar bold and fades the rest, so it
      // stays visible until Save/Dismiss; no selection → all bars full.
      data: rows.map((r, i) => ({
        value: r.lost,
        itemStyle: { color: loss, borderRadius: [0, 4, 4, 0], opacity: sel == null || sel === i ? 1 : 0.12 },
      })),
      label: {
        show: true, position: 'right', fontSize: 11, fontWeight: 600,
        color: (p: any) => (sel == null || sel === p.dataIndex ? C.muted : C.border),
        formatter: (p: any) => { const r = rows[p.dataIndex]; return `${r.lost.toLocaleString()}  ·  ${r.pct}%` },
      },
    }],
  }
})
</script>

<template><BaseChart :option="option" @chart-click="onClick" /></template>
