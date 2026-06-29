<script setup lang="ts">
// Compare (multi-series): overlay several named series on one chart. Either split a
// fact's values into series, or define custom named cohorts (each reuses ConditionRow).
// For bars/area a stack mode (grouped / stacked / 100%) is offered.
import Select from 'primevue/select'
import InputText from 'primevue/inputtext'
import Button from 'primevue/button'
import ToggleSwitch from 'primevue/toggleswitch'
import ConditionRow from './ConditionRow.vue'
defineProps<{ model: any }>()
</script>

<template>
  <label class="lab row">
    <i class="pi pi-clone ic" />Compare
    <ToggleSwitch v-model="model.compareOn" class="cmp-sw" />
  </label>
  <p class="hint">Overlay several series — e.g. active vs lapsed — to compare them side by side.</p>

  <template v-if="model.compareOn">
    <div class="seg">
      <button type="button" class="seg-btn" :class="{ on: model.compareMode === 'split' }" @click="model.compareMode = 'split'">Split by field</button>
      <button type="button" class="seg-btn" :class="{ on: model.compareMode === 'custom' }" @click="model.compareMode = 'custom'">Custom series</button>
    </div>

    <template v-if="model.compareMode === 'split'">
      <label class="lab">Split by</label>
      <Select v-model="model.splitKey" :options="model.factKeys" optionLabel="label" optionValue="value" filter class="w" placeholder="a fact whose values become series" />
      <label class="lab">Values</label>
      <InputText v-model="model.splitVals" class="w" placeholder="active, lapsed" />
      <p class="hint">One series per value — comma-separated. Each is your query scoped to that value.</p>
    </template>

    <template v-else>
      <label class="lab row"><i class="pi pi-list ic" />Series <Button icon="pi pi-plus" text rounded size="small" @click="model.addSeries()" /></label>
      <p class="hint">Each series is a named cohort, measured the same way. e.g. <code>opened email</code> vs <code>got a call</code>.</p>
      <ConditionRow v-for="(s, i) in model.customSeries" :key="i" compact :condition="s.c"
        :fact-keys="model.factKeys" :event-opts="model.eventOpts"
        @remove="model.removeSeries(i)">
        <template #lead><InputText v-model="s.name" class="cs-name" placeholder="Series name" /></template>
      </ConditionRow>
      <p v-if="!model.customSeries.length" class="hint">No series yet — add the cohorts to compare.</p>
    </template>

    <template v-if="model.canStack">
      <label class="lab"><i class="pi pi-chart-bar ic" />Stack</label>
      <div class="seg">
        <button type="button" class="seg-btn" :class="{ on: model.stackMode === 'group' }" @click="model.stackMode = 'group'">{{ model.kind === 'timeseries' ? 'Lines' : 'Grouped' }}</button>
        <button type="button" class="seg-btn" :class="{ on: model.stackMode === 'stack' }" @click="model.stackMode = 'stack'">Stacked</button>
        <button type="button" class="seg-btn" :class="{ on: model.stackMode === 'pct' }" @click="model.stackMode = 'pct'">100%</button>
      </div>
      <p class="hint">{{ model.stackMode === 'pct' ? 'Each bucket shown as a share of 100%.' : model.stackMode === 'stack' ? 'Series stacked into one total.' : 'Series shown side by side.' }}</p>
    </template>
  </template>
</template>
