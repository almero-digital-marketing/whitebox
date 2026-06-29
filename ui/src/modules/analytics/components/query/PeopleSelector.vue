<script setup lang="ts">
// stat / table — the full people selector: an optional KPI target (stat only), a
// semantic "topic" narrow, a list of fact/activity conditions (all/any), and an
// optional AI judge predicate.
import Select from 'primevue/select'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import Textarea from 'primevue/textarea'
import Button from 'primevue/button'
import ConditionRow from './ConditionRow.vue'
import { COMBINATORS } from './constants'
defineProps<{ model: any }>()
</script>

<template>
  <template v-if="model.kind === 'stat'">
    <label class="lab"><i class="pi pi-flag ic" />Target <span class="muted small">(optional)</span></label>
    <InputNumber v-model="model.target" :min="0" class="w" placeholder="goal — e.g. 200" />
    <p class="hint">Show the count as progress toward this goal.</p>
  </template>

  <label class="lab"><i class="pi pi-compass ic" />Topic <span class="muted small">(optional)</span></label>
  <InputText v-model="model.about" class="w" placeholder="e.g. competitor, switching, cancel" />
  <p class="hint">Semantic narrow — keep only people whose memory mentions this idea.</p>

  <label class="lab row">
    <i class="pi pi-sliders-h ic" />Match
    <Select v-model="model.combinator" :options="COMBINATORS" optionLabel="label" optionValue="value" class="comb" />
    of these conditions
    <Button icon="pi pi-plus" text rounded size="small" @click="model.addCondition()" />
  </label>
  <p class="hint"><b>Fact</b> = a stored attribute (status, membership…). <b>Activity</b> = events they did (emails, calls, bookings…) by action and campaign.</p>

  <ConditionRow v-for="(c, i) in model.conditions" :key="i" :condition="c"
    :fact-keys="model.factKeys" :event-opts="model.eventOpts" :campaign-opts="model.campaignOpts"
    @remove="model.removeCondition(i)" />
  <p v-if="!model.conditions.length" class="hint">No conditions — matches everyone.</p>

  <label class="lab"><i class="pi pi-bolt ic" />Judge <span class="muted small">(optional)</span></label>
  <Textarea v-model="model.judgeCriteria" rows="2" autoResize class="w" placeholder="e.g. genuinely at risk of churning" />
  <p class="hint">An AI predicate run per person against their memory — for fuzzy criteria a filter can't express.</p>
  <template v-if="model.judgeCriteria.trim()">
    <label class="lab">Confidence</label>
    <InputNumber v-model="model.judgeConfidence" :min="0" :max="1" :step="0.05" :minFractionDigits="2" showButtons class="w" />
  </template>
</template>
