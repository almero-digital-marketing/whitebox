<script setup lang="ts">
// Multi line (timeseries) or grouped bars (breakdown) over a shared axis. stack 'stack'
// overlays series into one column/area; 'pct' normalises each bucket to 100% (share).
import { computed } from 'vue'
import BaseChart from './BaseChart.vue'
import { readTheme, legendBase, alignSeries } from './theme'
const props = defineProps<{ kind: string; multi: any; stack?: 'group' | 'stack' | 'pct'; selectedMulti?: { bucket: string; series: string } | null }>()
const emit = defineEmits<{ select: [sel: any] }>()
defineOptions({ inheritAttrs: false })
const { C, PALETTE } = readTheme()
// a grouped/stacked BAR → a compound segment: the x-axis bucket (group.by value) AND the
// series (splitBy value). Timeseries lines aren't selectable (a time point isn't a cohort).
function onClick(p: any) {
  if (props.kind === 'timeseries') return
  if (p?.name == null || p?.seriesName == null) return
  emit('select', { kind: 'breakdown-split', bucket: p.name, series: p.seriesName })
}
const option = computed(() => {
  const line = props.kind === 'timeseries'
  const pct = props.stack === 'pct'
  const stacked = props.stack === 'stack' || pct
  const sm = props.selectedMulti   // the selected (bucket × series) bar — dim the rest
  let { axis, series } = alignSeries(props.multi?.series || [])
  if (pct) {   // normalise each bucket's values to percentages
    series = series.map((s) => ({ ...s, values: [...s.values] }))
    for (let i = 0; i < axis.length; i++) {
      const sum = series.reduce((a, s) => a + (s.values[i] || 0), 0) || 1
      series.forEach((s) => { s.values[i] = Math.round((s.values[i] / sum) * 1000) / 10 })
    }
  }
  // a breakdown must show EVERY category (a dropped treatment is the bug); rotate the
  // labels when they're many/long so they don't overlap. Timeseries keeps auto-thinning.
  const longest = Math.max(0, ...axis.map((a) => String(a).length))
  const rotate = !line && (axis.length > 5 || longest > 9) ? 30 : 0
  return {
    grid: { left: pct ? 46 : 44, right: 14, top: 30, bottom: rotate ? 54 : 30 },
    tooltip: { trigger: 'axis', valueFormatter: pct ? ((v: number) => `${v}%`) : undefined },
    legend: legendBase(C),
    xAxis: { type: 'category', data: axis, axisLabel: { color: C.muted, fontSize: 10, interval: line ? 'auto' : 0, hideOverlap: line, rotate }, axisLine: { lineStyle: { color: C.border } } },
    yAxis: { type: 'value', max: pct ? 100 : undefined, axisLabel: { color: C.muted, fontSize: 10, formatter: pct ? '{value}%' : undefined }, splitLine: { lineStyle: { color: C.grid } } },
    color: PALETTE,
    series: series.map((s, i) => (line ? {
      name: s.name, type: 'line', data: s.values, smooth: !stacked, showSymbol: !stacked && axis.length <= 40, symbolSize: 5,
      stack: stacked ? 'total' : undefined,
      lineStyle: { color: PALETTE[i % PALETTE.length], width: 2 }, itemStyle: { color: PALETTE[i % PALETTE.length] },
      areaStyle: stacked ? { color: PALETTE[i % PALETTE.length], opacity: 0.5 } : undefined,
    } : {
      name: s.name, type: 'bar', barMaxWidth: stacked ? 44 : 30,
      stack: stacked ? 'total' : undefined,
      // per-bar so the selected (bucket × series) stays lit and the rest dim
      data: s.values.map((v, j) => ({
        value: v,
        itemStyle: {
          color: PALETTE[i % PALETTE.length], borderRadius: stacked ? 0 : [3, 3, 0, 0],
          opacity: sm == null || (s.name === sm.series && axis[j] === sm.bucket) ? 1 : 0.18,
        },
      })),
    })),
  }
})
</script>

<template><BaseChart :option="option" @chart-click="onClick" /></template>
