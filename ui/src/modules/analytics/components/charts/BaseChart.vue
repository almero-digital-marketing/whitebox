<script setup lang="ts">
// The shared chart renderer: registers the ECharts pieces once, gates the mount on a
// real size, and draws the given option. Every kind chart renders through this, so the
// registration and the sizing logic live in exactly one place.
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { LineChart, BarChart, FunnelChart, PieChart, RadarChart, ScatterChart, HeatmapChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, RadarComponent, LegendComponent, VisualMapComponent } from 'echarts/components'
import VChart from 'vue-echarts'

use([CanvasRenderer, LineChart, BarChart, FunnelChart, PieChart, RadarChart, ScatterChart, HeatmapChart, GridComponent, TooltipComponent, RadarComponent, LegendComponent, VisualMapComponent])

defineProps<{ option: any }>()
defineEmits<{ chartClick: [params: any] }>()

// Only mount the chart once the host has real dimensions, so ECharts doesn't init at 0
// size (which warns and paints nothing); autoresize tracks it after. The host carries a
// fixed height, so it's usually already sized at mount — take that synchronously rather
// than waiting on a ResizeObserver callback (which can be delayed). The observer stays
// as a fallback for a 0×0 mount.
const host = ref<HTMLElement | null>(null)
const ready = ref(false)
let ro: ResizeObserver | null = null
onMounted(() => {
  if (!host.value) return
  const r = host.value.getBoundingClientRect()
  if (r.width > 0 && r.height > 0) ready.value = true
  if (!ready.value) {
    ro = new ResizeObserver(([e]) => {
      const cr = e?.contentRect
      if (cr && cr.width > 0 && cr.height > 0) { ready.value = true; ro?.disconnect(); ro = null }
    })
    ro.observe(host.value)
  }
})
onBeforeUnmount(() => { ro?.disconnect(); ro = null })
</script>

<template>
  <div ref="host" class="chart-host">
    <VChart v-if="ready" :option="option" autoresize style="height: 100%; width: 100%;" @click="$emit('chartClick', $event)" />
  </div>
</template>

<style scoped>
.chart-host { height: 100%; width: 100%; min-height: 150px; }
</style>
