<script setup lang="ts">
import Select from 'primevue/select'
defineProps<{ model: any }>()
</script>

<template>
  <label class="lab"><i class="pi pi-chart-scatter ic" />X axis <span class="muted small">(numeric fact)</span></label>
  <Select v-model="model.scatterX" :options="model.numericFactKeys" optionLabel="label" optionValue="value" filter class="w" placeholder="pick a numeric fact" />
  <label class="lab">Y axis <span class="muted small">(numeric fact)</span></label>
  <Select v-model="model.scatterY" :options="model.numericFactKeys" optionLabel="label" optionValue="value" filter class="w" placeholder="pick a numeric fact" />
  <p class="hint">One dot per person at (X, Y). Only people who have both facts are plotted.</p>
  <label class="lab">Colour by <span class="muted small">(optional)</span></label>
  <Select v-model="model.scatterColor" :options="model.factKeys" optionLabel="label" optionValue="value" filter showClear class="w" placeholder="single colour" />
  <p class="hint">Tints the dots by a categorical fact — e.g. <code>client_status</code> or <code>membership</code>.</p>
</template>
