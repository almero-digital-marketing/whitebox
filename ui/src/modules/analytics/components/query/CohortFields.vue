<script setup lang="ts">
import Select from 'primevue/select'
import InputNumber from 'primevue/inputnumber'
import { COHORT_GRAINS } from './constants'
defineProps<{ model: any }>()
</script>

<template>
  <label class="lab"><i class="pi pi-bolt ic" />Cohort activity <span class="muted small">(optional)</span></label>
  <Select v-model="model.cohortEvent" :options="model.eventOpts" optionLabel="label" optionValue="value" filter showClear class="w" placeholder="any activity" />
  <p class="hint">People are grouped by the period of their first <code>{{ model.cohortEvent || 'activity' }}</code>; cells show how many stay active.</p>
  <label class="lab">Period</label>
  <Select v-model="model.cohortGrain" :options="COHORT_GRAINS" optionLabel="label" optionValue="value" class="w" />
  <label class="lab">Periods to track</label>
  <InputNumber v-model="model.cohortPeriods" :min="1" :max="24" showButtons class="w" />
</template>
