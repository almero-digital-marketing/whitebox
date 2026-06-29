<script setup lang="ts">
// A search box pinned to the bottom of a left rail. Filtering is client-side and owned by the
// host (this just emits the query via v-model). Place it as the last child of a flex-column pane
// whose list flexes to fill, so it sits flush at the bottom.
defineProps<{ modelValue: string; placeholder?: string }>()
defineEmits<{ (e: 'update:modelValue', v: string): void }>()
</script>

<template>
  <div class="rail-search">
    <i class="pi pi-search rs-icon" />
    <input :value="modelValue" :placeholder="placeholder || 'Search'" spellcheck="false"
      @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)" />
    <button v-if="modelValue" type="button" class="rs-clear" aria-label="Clear search"
      @click="$emit('update:modelValue', '')"><i class="pi pi-times" /></button>
  </div>
</template>

<style scoped>
.rail-search { flex: none; display: flex; align-items: center; gap: 8px; padding: 9px 14px; border-top: 1px solid var(--border); background: var(--panel); }
.rs-icon { font-size: 12px; color: var(--muted); }
.rail-search input { flex: 1 1 auto; min-width: 0; border: none; background: transparent; outline: none; font: inherit; font-size: 13px; color: var(--text); }
.rail-search input::placeholder { color: var(--muted); }
.rs-clear { border: none; background: none; color: var(--muted); cursor: pointer; font-size: 11px; padding: 2px; display: inline-flex; }
.rs-clear:hover { color: var(--text-strong); }
</style>
