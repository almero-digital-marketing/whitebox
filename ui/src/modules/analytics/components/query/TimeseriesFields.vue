<script setup lang="ts">
import Select from 'primevue/select'
import MultiSelect from 'primevue/multiselect'
import { AGGS, GRAINS } from './constants'
defineProps<{ model: any }>()
</script>

<template>
  <label class="lab"><i class="pi pi-bolt ic" />Event</label>
  <MultiSelect v-model="model.tsEvents" :options="model.eventOpts" optionLabel="label" optionValue="value" filter display="chip" placeholder="pick event action(s)" class="w" />
  <p class="hint">The action counted per period — e.g. <code>email_open</code>, <code>booking</code>. Pick one or several.</p>
  <label class="lab">Aggregate</label>
  <Select v-model="model.tsAgg" :options="AGGS" optionLabel="label" optionValue="value" class="w" />
  <label class="lab">Time grain</label>
  <Select v-model="model.grain" :options="GRAINS" optionLabel="label" optionValue="value" class="w" />
</template>
