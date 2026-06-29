<script setup lang="ts">
// funnel / dropoff — both define the same ordered stages. Dropoff (the "negative
// funnel") renders the people lost between steps; the wording switches on kind.
import Select from 'primevue/select'
import InputText from 'primevue/inputtext'
import Button from 'primevue/button'
defineProps<{ model: any }>()
</script>

<template>
  <label class="lab row">
    <i :class="model.kind === 'dropoff' ? 'pi pi-filter-slash ic' : 'pi pi-filter ic'" />{{ model.kind === 'dropoff' ? 'Drop-off steps' : 'Funnel steps' }} <span class="muted small">(top to bottom)</span>
    <Button icon="pi pi-plus" text rounded size="small" @click="model.addStep()" />
  </label>
  <p class="hint">{{ model.kind === 'dropoff'
    ? 'Same ordered stages as a funnel — the chart shows how many people are LOST between each step (the re-engagement audiences).'
    : 'Each step keeps the people from the step above who also did that event — the drop-off is the funnel.' }}</p>
  <div v-for="(s, i) in model.steps" :key="i" class="step">
    <span class="step-n">{{ i + 1 }}</span>
    <InputText v-model="s.name" class="step-name" placeholder="Label" />
    <Select v-model="s.event" :options="model.eventOpts" optionLabel="label" optionValue="value" filter placeholder="event action" class="step-tag" />
    <Button icon="pi pi-times" text rounded size="small" severity="secondary" @click="model.removeStep(i)" />
  </div>
  <p v-if="!model.steps.length" class="hint">No steps yet — add the stages in order.</p>
</template>
