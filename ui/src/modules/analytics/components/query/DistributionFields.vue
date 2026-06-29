<script setup lang="ts">
import Select from 'primevue/select'
import InputText from 'primevue/inputtext'
import { DIST_SOURCES } from './constants'
defineProps<{ model: any }>()
</script>

<template>
  <label class="lab"><i class="pi pi-objects-column ic" />Distribution of</label>
  <Select v-model="model.distSource" :options="DIST_SOURCES" optionLabel="label" optionValue="value" class="w" @change="model.distKey = ''" />
  <label class="lab">{{ model.distSource === 'event' ? 'Event' : 'Numeric fact' }}</label>
  <Select v-model="model.distKey" :options="model.distKeyOpts" optionLabel="label" optionValue="value" filter class="w"
    :placeholder="model.distSource === 'event' ? 'pick an event action' : 'pick a numeric fact'" />
  <p class="hint">{{ model.distSource === 'event'
    ? 'Buckets people by how many of this event they did — 1, 2, 3 …'
    : 'Buckets people by the value of this fact, e.g. lifetime value or visit count.' }}</p>
  <label class="lab">Buckets <span class="muted small">(optional)</span></label>
  <InputText v-model="model.distBins" class="w" placeholder="auto — or edges e.g. 0, 100, 500, 1000" />
  <p class="hint">Leave blank for automatic bins, or list the bucket edges, comma-separated.</p>
</template>
