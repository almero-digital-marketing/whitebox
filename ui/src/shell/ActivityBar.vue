<script setup lang="ts">
import type { ModuleDef } from './modules'
defineProps<{ modules: ModuleDef[]; activeId: string }>()
defineEmits<{ select: [id: string] }>()
</script>

<template>
  <nav class="activity-bar">
    <div class="ab-brand" title="WhiteBox">
      <img src="/logo.svg" alt="WhiteBox" width="30" height="30" />
    </div>
    <button v-for="m in modules" :key="m.id" type="button" class="ab-item" :class="{ on: m.id === activeId }"
      v-tooltip.right="m.label" :aria-label="m.label" @click="$emit('select', m.id)">
      <i :class="m.icon" />
    </button>
  </nav>
</template>

<style scoped>
.activity-bar { flex: none; width: 52px; height: 100%; display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 8px 0; background: var(--panel); border-right: 1px solid var(--border); }
.ab-brand { width: 40px; height: 40px; display: grid; place-items: center; margin-bottom: 8px; }
.ab-brand img { display: block; width: 30px; height: 30px; }
.ab-item { position: relative; width: 40px; height: 40px; display: grid; place-items: center; border: none; border-radius: 9px; background: transparent; color: var(--muted); cursor: pointer; transition: color .12s, background .12s; }
.ab-item:hover { color: var(--text-strong); background: var(--panel-2); }
.ab-item.on { color: var(--accent); background: var(--accent-soft); }
/* VS Code-style active indicator on the far-left edge */
.ab-item.on::before { content: ''; position: absolute; left: -6px; top: 9px; bottom: 9px; width: 2.5px; border-radius: 2px; background: var(--accent); }
.ab-item i { font-size: 18px; }
</style>
