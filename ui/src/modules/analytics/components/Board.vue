<script setup lang="ts">
import { ref, watch } from 'vue'
import draggable from 'vuedraggable'
import WidgetCard from './WidgetCard.vue'

const props = defineProps<{ report: any; data: Record<string, any>; selectedId?: string; columns?: number }>()
const emit = defineEmits(['remove', 'select', 'add', 'reorder', 'deselect'])

// click on empty board space (not on a widget card) → deselect the current widget
function onBgClick(e: MouseEvent) {
  if (!(e.target as HTMLElement).closest('.card')) emit('deselect')
}

// Local, draggable copy of the widget list. Kept in sync with the report; the
// drag library mutates this array, and on drop we emit the new id order.
const items = ref<any[]>([])
watch(() => props.report?.widgets, (w) => { items.value = (w || []).slice() }, { immediate: true })

function onReorder() {
  emit('reorder', items.value.map((w: any) => w.id))
}
</script>

<template>
  <div v-if="!report" class="placeholder muted">
    <div>
      <h2>WhiteBox Analytics</h2>
      <p>Pick a report on the left, or ask a question to build one.</p>
    </div>
  </div>
  <div v-else class="doc-wrap" @click="onBgClick">
    <draggable v-model="items" item-key="id" handle=".card-head" :animation="160"
      ghost-class="drag-ghost" class="doc" :class="{ 'cols-2': columns === 2 }" @end="onReorder">
      <template #item="{ element }">
        <div class="doc-item">
          <WidgetCard :widget="element" :state="data[element.id]" :selected="element.id === selectedId"
            @remove="emit('remove', $event)" @select="emit('select', $event)" />
        </div>
      </template>
    </draggable>
    <button class="add-fab" @click="emit('add')" title="Add widget"><i class="pi pi-plus" /> Add widget</button>
  </div>
</template>

<style scoped>
.placeholder { display: grid; place-items: center; height: 100%; text-align: center; }
.placeholder h2 { margin: 0 0 6px; color: var(--text); }
.doc-wrap { min-height: 100%; }
/* document flow — one full-width section on top of the other */
.doc { display: flex; flex-direction: column; gap: 32px; padding: 26px 28px 96px; }
/* two-column board (when the compose pane is collapsed) — more widgets at a glance */
.doc.cols-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 30px 34px; align-items: start; }
.doc-item { width: 100%; min-width: 0; }
.drag-ghost > * { box-shadow: 0 0 0 2px var(--accent-soft); border-radius: 10px; }
/* floating action button — pinned to the pane's bottom-right while the doc scrolls */
.add-fab { position: fixed; right: 22px; bottom: 22px; z-index: 5; display: inline-flex; align-items: center; gap: 7px; padding: 11px 17px; border: none; border-radius: 999px; background: var(--accent); color: #fff; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; box-shadow: var(--shadow-md); transition: transform .12s, box-shadow .12s, filter .12s; }
.add-fab:hover { filter: brightness(1.1); box-shadow: 0 10px 26px rgba(15, 23, 42, .18); transform: translateY(-1px); }
.add-fab:active { transform: translateY(0); }
.add-fab .pi { font-size: 13px; }
</style>
