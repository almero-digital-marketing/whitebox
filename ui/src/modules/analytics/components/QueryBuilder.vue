<script setup lang="ts">
// The structured "Query" editor. The form model (state + parse/build/validate +
// schema option lists) lives in useQueryModel; each visualization kind has its own
// field-editor under ./query. This component is the shell: title, the kind picker,
// the per-kind dispatch, the (optional) compare section, and the action bar.
import { ref, computed } from 'vue'
import InputText from 'primevue/inputtext'
import Button from 'primevue/button'
import { api } from '../api'
import { useQueryModel } from './query/useQueryModel'
import VizPicker from './query/VizPicker.vue'
import AnswerFields from './query/AnswerFields.vue'
import BreakdownFields from './query/BreakdownFields.vue'
import DistributionFields from './query/DistributionFields.vue'
import ScatterFields from './query/ScatterFields.vue'
import CohortFields from './query/CohortFields.vue'
import TimeseriesFields from './query/TimeseriesFields.vue'
import FunnelFields from './query/FunnelFields.vue'
import PeopleSelector from './query/PeopleSelector.vue'
import CompareSection from './query/CompareSection.vue'
import './query/qb.css'

const props = defineProps<{ widget: any; schema: any }>()
const emit = defineEmits(['save', 'cancel'])
const m = useQueryModel(props)

// the field-editor for the current kind (stat/table fall through to the people selector)
const fields = computed(() => {
  const k = m.kind
  if (k === 'answer') return AnswerFields
  if (m.isBreakdownLike) return BreakdownFields
  if (k === 'distribution') return DistributionFields
  if (k === 'scatter') return ScatterFields
  if (k === 'cohort') return CohortFields
  if (k === 'timeseries') return TimeseriesFields
  if (k === 'funnel' || k === 'dropoff') return FunnelFields
  return PeopleSelector
})

const isNew = computed(() => !props.widget)
const preview = ref('')
const previewing = ref(false)
async function run() {
  previewing.value = true; preview.value = ''
  try {
    const r = await api.resolve(m.build())
    preview.value = r?.multi ? `${r.series.length} series`
      : r?.count != null ? `${r.count} people`
        : Array.isArray(r) ? `${r.length} buckets`
          : r?.points ? `${r.points.length} dots`
            : r?.series ? `${r.series.length} buckets` : r?.answer ? r.answer.slice(0, 160) : JSON.stringify(r).slice(0, 160)
  } catch (e: any) { preview.value = 'Error: ' + e.message }
  finally { previewing.value = false }
}
function save() { emit('save', { title: m.title, kind: m.kind, query: m.build() }); m.captureOriginal() }
// Cancel backs out entirely — no edit applied, no widget left selected. The editor
// unmounts (parent clears the selection + returns to Agent), so no form revert needed.
function cancel() { preview.value = ''; emit('cancel') }
defineExpose({ build: m.build, hasContent: m.hasContent, isDirty: m.isDirty })
</script>

<template>
  <div class="qb">
    <label class="lab">Title</label>
    <InputText v-model="m.title" class="w" />

    <VizPicker v-model:kind="m.kind" />

    <component :is="fields" :model="m" />

    <CompareSection v-if="m.canCompare" :model="m" />

    <div class="qb-actions">
      <Button label="Cancel" text severity="secondary" size="small" class="cancel" @click="cancel" />
      <span v-if="preview" class="result" :class="{ err: preview.startsWith('Error') }">{{ preview }}</span>
      <Button label="Run" :loading="previewing" severity="secondary" outlined size="small" @click="run" />
      <Button :label="isNew ? 'Add to report' : 'Save'" size="small" @click="save" />
    </div>
  </div>
</template>
