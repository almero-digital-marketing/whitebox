<script setup lang="ts">
import Button from 'primevue/button'
defineProps<{ reports: any[]; currentId?: string }>()
const emit = defineEmits(['open', 'new', 'remove'])
// real widget count from the server; fall back to layout length for any older row
const insightCount = (r: any) => r.widget_count ?? (r.layout?.length ?? 0)
</script>

<template>
  <div class="pane-head">Reports <Button icon="pi pi-plus" text rounded size="small" aria-label="New report" @click="emit('new')" /></div>
  <ul class="list">
    <li v-if="!reports.length" class="empty muted">No reports yet — ask something →</li>
    <li v-for="r in reports" :key="r.id" class="item" :class="{ on: r.id === currentId }" @click="emit('open', r.id)">
      <div class="it-main">
        <span class="it-name" :title="r.name">{{ r.name }}</span>
        <span class="it-sub">{{ insightCount(r) }} insight{{ insightCount(r) === 1 ? '' : 's' }}</span>
      </div>
      <button class="it-x" title="Remove" aria-label="Remove" @click.stop="emit('remove', r)"><i class="pi pi-times" /></button>
    </li>
  </ul>
</template>

<style scoped>
.list { list-style: none; margin: 0; padding: 8px; }
.item { display: flex; align-items: center; gap: 6px; padding: 9px 10px; border-radius: 8px; cursor: pointer; }
.item:hover { background: var(--panel-2); }
.item.on { background: var(--accent-soft); }
.it-main { flex: 1 1 auto; min-width: 0; }
.it-name { display: block; font-size: 14px; font-weight: 600; color: var(--text-strong); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.item.on .it-name { color: var(--accent); }
.it-sub { display: block; font-size: 11px; color: var(--muted); }
.it-x { border: none; background: none; color: var(--muted); cursor: pointer; opacity: 0; font-size: 12px; padding: 0; transition: opacity .12s; }
.item:hover .it-x { opacity: 1; }
.it-x:hover { color: var(--text-strong); }
.empty { padding: 16px 10px; font-size: 13px; color: var(--muted); cursor: default; line-height: 1.5; }
</style>
