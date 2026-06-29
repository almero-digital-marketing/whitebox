<script setup lang="ts">
// One condition on a person: a stored Fact (key/op/value) or an Activity they did
// (events + campaign + a count/sum threshold). Reused by the people-selector and by
// custom-series. `compact` (custom-series) shows only the events row; the `lead` slot
// holds the series name. Mutates the passed-in condition object (a model array item).
import Select from 'primevue/select'
import MultiSelect from 'primevue/multiselect'
import InputText from 'primevue/inputtext'
import Button from 'primevue/button'
import { OPS, CLAUSE_TYPES, MEASURES, CMPS } from './constants'

defineProps<{
  condition: any
  factKeys: any[]
  eventOpts: any[]
  campaignOpts?: any[]
  compact?: boolean
}>()
defineEmits(['remove'])
</script>

<template>
  <div class="cond">
    <div class="cond-top">
      <slot name="lead" />
      <Button :label="condition.not ? 'is not' : 'is'" size="small" :severity="condition.not ? 'danger' : 'secondary'"
        :outlined="!condition.not" class="notbtn" @click="condition.not = !condition.not" />
      <Select v-model="condition.type" :options="CLAUSE_TYPES" optionLabel="label" optionValue="value" class="cond-type" />
      <span v-if="!compact" class="cond-note muted small">{{ condition.type === 'fact' ? 'a stored attribute' : 'an action they took' }}</span>
      <Button icon="pi pi-times" text rounded size="small" severity="secondary" @click="$emit('remove')" />
    </div>

    <div v-if="condition.type === 'fact'" class="cond-fields">
      <Select v-model="condition.key" :options="factKeys" optionLabel="label" optionValue="value" filter placeholder="fact" class="f-key" />
      <Select v-model="condition.op" :options="OPS" optionLabel="label" optionValue="value" class="f-op" />
      <InputText v-if="condition.op !== 'present'" v-model="condition.value" class="f-val" placeholder="value" />
    </div>

    <div v-else class="cond-metric">
      <div class="m-row"><span class="m-lab">did</span>
        <MultiSelect v-model="condition.events" :options="eventOpts" optionLabel="label" optionValue="value" filter display="chip" placeholder="any event" class="m-grow" /></div>
      <template v-if="!compact">
        <div class="m-row"><span class="m-lab">campaign</span>
          <MultiSelect v-model="condition.campaigns" :options="campaignOpts" optionLabel="label" optionValue="value" filter display="chip" placeholder="any campaign" class="m-grow" /></div>
        <div class="m-row">
          <Select v-model="condition.measure" :options="MEASURES" optionLabel="label" optionValue="value" class="f-op" />
          <Select v-model="condition.cmp" :options="CMPS" optionLabel="label" optionValue="value" class="f-cmp" />
          <InputText v-model="condition.mvalue" class="f-num" placeholder="n" />
          <InputText v-model="condition.window" class="f-win" placeholder="any time" />
        </div>
      </template>
    </div>
  </div>
</template>
