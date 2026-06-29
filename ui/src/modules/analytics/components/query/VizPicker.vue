<script setup lang="ts">
// The "Visualization" chooser — the grid of kinds + the one-line hint for the
// selected kind. Two-way binds the kind via v-model.
import { KINDS, KIND_HINTS } from './constants'
const kind = defineModel<string>('kind', { required: true })
</script>

<template>
  <label class="lab">Visualization</label>
  <div class="viz-grid">
    <button v-for="k in KINDS" :key="k.value" type="button" class="viz" :class="{ on: kind === k.value }" @click="kind = k.value">
      <i :class="k.icon" /><span>{{ k.label }}</span>
    </button>
  </div>
  <p class="hint">{{ KIND_HINTS[kind] || '' }}</p>
</template>
