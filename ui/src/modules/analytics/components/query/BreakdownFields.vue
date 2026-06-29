<script setup lang="ts">
// breakdown / donut / radar / pivot / heatmap — all share the same "break down by a
// dimension" builder; only the rendering differs. The icon/verb/unit wording comes
// from the model (bdIcon/bdVerb/bdUnit) per kind.
import Select from 'primevue/select'
import InputText from 'primevue/inputtext'
import { MEASURE2 } from './constants'
defineProps<{ model: any }>()
</script>

<template>
  <label class="lab"><i :class="model.bdIcon" />{{ model.bdVerb }}</label>
  <Select v-model="model.breakdownDim" :options="model.breakdownDims" optionLabel="label" optionValue="value" filter class="w" placeholder="pick a dimension" />
  <template v-if="model.isFactDim">
    <label class="lab">Values</label>
    <InputText v-model="model.breakdownValues" class="w" placeholder="lead, active, lapsed" />
    <p class="hint">One {{ model.bdUnit }} per value — type the fact values to compare, comma-separated.</p>
  </template>
  <template v-else-if="model.breakdownDim">
    <label class="lab">Measure</label>
    <Select v-model="model.breakdownMeasure" :options="MEASURE2" optionLabel="label" optionValue="value" class="w" />
    <p class="hint">People = distinct customers per {{ model.bdUnit }}; Events = total events.</p>
  </template>
</template>
