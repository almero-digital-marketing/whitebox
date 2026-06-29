<script setup lang="ts">
// Campaigns module — same three-pane logic as audiences:
//   left  = saved campaigns (pick / + New)
//   mid   = campaign-enabled audiences palette (click to attach — a campaign targets the UNION)
//   right = the open campaign: details + message + delivery preview/send, or (once sent) stats + report
// The UI authors the campaign end-to-end (audiences, message, schedule) and sends it. Campaign
// content can ALSO be upserted by an external pipeline (by external_id) — optional, not surfaced.
// Executing locks the campaign with real stats; a sent campaign can build a perf report.
import { ref, computed, watch, onActivated } from 'vue'
import { storeToRefs } from 'pinia'
import { useRoute, useRouter } from 'vue-router'
import { useConfirm } from 'primevue/useconfirm'
import ConfirmDialog from 'primevue/confirmdialog'
import Button from 'primevue/button'
import Textarea from 'primevue/textarea'
import InputText from 'primevue/inputtext'
// Email body editor: TinyMCE, self-hosted (no cloud/API key) — it ships a native source-code
// view (the `code` plugin), so "view HTML" is built in.
import Editor from '@tinymce/tinymce-vue'
import 'tinymce/tinymce'
import 'tinymce/models/dom/model'
import 'tinymce/themes/silver/theme'
import 'tinymce/icons/default/icons'
import 'tinymce/skins/ui/oxide/skin.min.css'
import 'tinymce/plugins/code/plugin'
import 'tinymce/plugins/lists/plugin'
import 'tinymce/plugins/link/plugin'
import 'tinymce/plugins/image/plugin'
// content styles fed into the editor iframe (we self-host, so content_css is off)
import tinyContentCss from 'tinymce/skins/content/default/content.min.css?raw'
import tinyContentUiCss from 'tinymce/skins/ui/oxide/content.min.css?raw'
// Full-HTML email "View source": a plain-text CodeMirror (syntax-highlighted, editable) — unlike
// TinyMCE it never rewrites the markup, so the document stays intact.
import { Codemirror } from 'vue-codemirror'
import { basicSetup } from 'codemirror'
import { html as cmHtml } from '@codemirror/lang-html'
import RailSearch from '../../components/RailSearch.vue'
import { useCampaignsStore } from './stores/campaigns'
import { useAudiencesStore } from '../analytics/stores/audiences'

const confirm = useConfirm()
const route = useRoute()
const router = useRouter()
const paramStr = (p: any): string => (Array.isArray(p) ? p[0] : p) || ''
const store = useCampaignsStore()
const audStore = useAudiencesStore()
const { campaigns } = storeToRefs(store)
// client-side rail search
const q = ref('')
const filteredCampaigns = computed(() => {
  const s = q.value.trim().toLowerCase()
  return s ? campaigns.value.filter((c: any) => (c.name || '').toLowerCase().includes(s)) : campaigns.value
})
const { audiences } = storeToRefs(audStore)

// the campaign currently open in the builder (the full row from getCampaign), or null
const working = ref<any>(null)
const pv = ref<any>(null)            // delivery preview (consent-gated union counts)
const saving = ref(false)
const building = ref(false)
// Composed content (name / subject / message) is edited in a LOCAL draft and committed with Save
// (or thrown away with Discard) — never auto-saved on every keystroke. `working` stays the
// persisted truth; `draft` is the in-progress edit.
const draft = ref<any>(null)
const fullDocSource = ref(false)   // full-HTML email: false = rendered preview, true = raw source
// A full HTML document (doctype/html/head/body) — built by an external email tool — would be
// wrecked by the fragment-only WYSIWYG, so it's previewed/source-viewed instead.
const FULLDOC_RE = /<\s*(?:!doctype|html|head|body)[\s>]/i
const isFullDoc = computed(() => FULLDOC_RE.test(draft.value?.message?.html || ''))
const cmExtensions = [basicSetup, cmHtml()]   // CodeMirror: full editor + HTML highlighting
// TinyMCE config — self-hosted (skin/content css imported above, so skin:false + content_css:false).
const tinymceInit = {
  height: '100%',   // fill the flex container (.msg-body); see the height chain in <style>

  menubar: false,
  branding: false,
  statusbar: false,
  skin: false,
  content_css: false,
  plugins: 'lists link image code',
  // full toolbar; tightened group spacing (CSS below) lets it fit the narrow compose pane on one
  // row. `wrap` (not the default overflow) so the source `</>` can never hide in a "more" menu.
  toolbar: 'blocks | bold italic underline forecolor | bullist numlist | link image | code',
  toolbar_mode: 'wrap',
  content_style: `${tinyContentUiCss}\n${tinyContentCss}\nbody{font-family:sans-serif;font-size:14px;line-height:1.5;margin:0;padding:12px}\nbody :first-child{margin-top:0}`,
}

// channels = delivery providers; radio list scales as more are added (viber, whatsapp, …)
const CHANNELS = [
  { label: 'Email', value: 'email', icon: 'pi pi-envelope' },
  { label: 'SMS', value: 'sms', icon: 'pi pi-comment' },
]
const emailPreviewHtml = computed(() => working.value?.message?.html
  || '<p style="font-family:sans-serif;color:#94a3b8;padding:24px">Nothing to preview yet — switch to Source to write.</p>')
// Campaign objectives — what it's for; the AI performance report is built around these.
const OBJECTIVES = ['Bookings', 'Revenue', 'Re-engagement', 'Retention', 'Awareness', 'Referrals']
const goals = computed(() => draft.value?.objective?.goals || [])
// locked = committed (scheduled) or already sent — read-only until unlocked
const locked = computed(() => !!working.value && working.value.status !== 'draft')
const attachedIds = computed(() => new Set((working.value?.audiences || []).map((a: any) => a.id)))
// the campaign-enabled audiences are the palette (a campaign targets one or more of them)
const palette = computed(() => audiences.value.filter((a: any) => a.campaigns))
const ready = computed(() => {
  const w = working.value; if (!w) return false
  return w.channel === 'sms' ? !!w.message?.text?.trim() : !!w.message?.html
})
// unsaved edits in the composed content (name / subject / message)
const dirty = computed(() => {
  const w = working.value, d = draft.value
  if (!w || !d) return false
  return (d.name ?? '') !== (w.name ?? '')
    || (d.subject ?? '') !== (w.subject ?? '')
    || (d.message?.html ?? '') !== (w.message?.html ?? '')
    || (d.message?.text ?? '') !== (w.message?.text ?? '')
    || (d.objective?.notes ?? '') !== (w.objective?.notes ?? '')
    || [...(d.objective?.goals || [])].sort().join('') !== [...(w.objective?.goals || [])].sort().join('')
})
// schedulable: a SAVED draft with audiences, a ready message AND a send date/time set
const schedulable = computed(() => !!working.value && !locked.value && !dirty.value && (working.value.audiences?.length || 0) > 0 && ready.value && !!working.value.scheduled_at)
const paneTitle = computed(() => (!locked.value ? 'Schedule' : working.value?.status === 'sent' ? 'Sent' : 'Scheduled'))
const fmt = (n: number | null | undefined) => (n == null ? '—' : Number(n).toLocaleString())
// the big number: live deliverable preview while drafting → projected reach once scheduled →
// actual sent count once delivered. Same visual either way.
const metric = computed(() => {
  const s = working.value?.stats
  if (locked.value && s) {
    const sent = working.value.status === 'sent'
    return { num: sent ? s.sent : s.reach, label: sent ? 'sent' : 'will reach', resolved: s.resolved, suppressed: s.suppressed, dry: s.dry_run }
  }
  if (!locked.value && pv.value) return { num: pv.value.deliverable, label: 'deliverable', resolved: pv.value.resolved, suppressed: pv.value.suppressed, dry: false }
  return null
})

onActivated(async () => {
  await Promise.all([store.loadCampaigns(), audStore.loadAudiences()])
  applyRoute()
})

// ── routing: the open campaign lives in the URL (/campaigns/:campaignId) ──
async function openCampaign(id: string) {
  const c = await store.getCampaign(id).catch(() => null)
  working.value = c
  resetDraft()              // seed the editable draft from the freshly-loaded campaign
  pv.value = null
  refreshPreview()
}
function applyRoute() {
  if (route.name !== 'campaigns') return
  const id = paramStr(route.params.campaignId)
  if (!id) { working.value = null; return }
  if (working.value?.id === id) return
  openCampaign(id)
}
watch([() => route.params.campaignId, campaigns], applyRoute, { immediate: true })
function goCampaign(id: string) { router.push({ name: 'campaigns', params: { campaignId: id } }) }

// + New creates a draft immediately (it needs an id to attach audiences), then opens it.
async function startNew() {
  const row = await store.createCampaign({ name: 'Untitled campaign', channel: 'sms', message: { text: '' } })
  goCampaign(row.id)
}
function removeCampaign(c: any) {
  confirm.require({
    header: 'Delete campaign', message: `Delete “${c.name}”? This can’t be undone.`, icon: 'pi pi-trash',
    defaultFocus: 'reject', acceptProps: { label: 'Delete', severity: 'danger' }, rejectProps: { label: 'Cancel', severity: 'secondary', outlined: true },
    accept: async () => { const open = working.value?.id === c.id; await store.removeCampaign(c.id); if (open) { working.value = null; router.replace({ name: 'campaigns', params: {} }) } },
  })
}

// All writes to `working` go through one serial chain, so rapid edits/attaches can't clobber
// each other with out-of-order responses — each op runs after the previous and reads the latest
// backend state. (Patch only updates the fields it's given, so order-preserving = no lost edits.)
let opChain: Promise<any> = Promise.resolve()
const serialize = (fn: () => Promise<any>) => { opChain = opChain.then(fn).catch(() => {}); return opChain }

// ── right-pane SETTINGS (channel · schedule · objectives) — applied immediately ──
// Optimistic: apply locally so the UI reacts instantly (and the delivery preview updates), then
// persist in the background. These are delivery settings, not composed content, so they're not
// part of the Save/Cancel draft. A field edit doesn't change the audience set, so we keep
// working.audiences (incl. sizes) as-is — no slow re-resolve, no waiting on the round-trip.
function patch(fields: Record<string, any>) {
  if (!working.value || locked.value) return
  const id = working.value.id
  working.value = { ...working.value, ...fields }
  return serialize(() => store.patchCampaign(id, fields).catch(() => {}))
}

// ── composed CONTENT (name · subject · message) — buffered in `draft`, committed with Save ──
function resetDraft() {
  const w = working.value
  draft.value = w ? {
    name: w.name ?? '', subject: w.subject ?? '', message: { ...(w.message || {}) },
    objective: { goals: [...(w.objective?.goals || [])], notes: w.objective?.notes ?? '' },
  } : null
  fullDocSource.value = false
}
// TinyMCE emits the new HTML on user edits; mirror it into the draft (Save commits it).
function onEditorHtml(html: string) {
  if (locked.value || !draft.value) return
  draft.value.message = { ...draft.value.message, html: html || '' }
}
function cancelEdits() { resetDraft() }
async function save() {
  if (!working.value || locked.value || !dirty.value || saving.value) return
  const id = working.value.id, w = working.value, d = draft.value
  const fields: Record<string, any> = {}
  if ((d.name ?? '') !== (w.name ?? '')) fields.name = d.name
  if ((d.subject ?? '') !== (w.subject ?? '')) fields.subject = d.subject
  if ((d.message?.html ?? '') !== (w.message?.html ?? '') || (d.message?.text ?? '') !== (w.message?.text ?? ''))
    fields.message = { ...(w.message || {}), ...d.message }
  if ((d.objective?.notes ?? '') !== (w.objective?.notes ?? '')
    || [...(d.objective?.goals || [])].sort().join('') !== [...(w.objective?.goals || [])].sort().join(''))
    fields.objective = { goals: [...(d.objective?.goals || [])], notes: d.objective?.notes ?? '' }
  saving.value = true
  try {
    working.value = { ...working.value, ...(await store.patchCampaign(id, fields)) }
    resetDraft()
  } finally { saving.value = false }
}
// scheduled_at is a single timestamp; the UI splits it into local date + time inputs and
// recombines on change (default 09:00 when only a date is given).
const setDate = (e: any) => commitSchedule(e.target.value, timeValue.value)
const setTime = (e: any) => commitSchedule(dateValue.value, e.target.value)
function commitSchedule(dateStr: string, timeStr: string) {
  if (!dateStr && !timeStr) return patch({ scheduled_at: null })
  const today = localDate(new Date().toISOString())
  patch({ scheduled_at: new Date(`${dateStr || today}T${timeStr || '09:00'}`).toISOString() })
}
async function setChannel(ch: 'email' | 'sms') { if (working.value && !locked.value) await patch({ channel: ch }) }
// objectives — toggle a goal chip / edit the notes; buffered in the draft like the rest of the
// composed content (Save commits them), and both drive the AI performance report.
function toggleGoal(g: string) {
  if (locked.value || !draft.value) return
  const cur = new Set(draft.value.objective.goals)
  cur.has(g) ? cur.delete(g) : cur.add(g)
  draft.value.objective = { ...draft.value.objective, goals: [...cur] }
}

// ── audiences (attach/detach → the campaign's union) ──
function toggleAudience(a: any) {
  if (!working.value || locked.value) return
  const id = working.value.id
  serialize(async () => {
    if (working.value?.id !== id) return
    const has = new Set((working.value.audiences || []).map((x: any) => x.id)).has(a.id)
    working.value = has ? await store.detachAudience(id, a.id) : await store.attachAudience(id, a.id)
  }).then(refreshPreview)
}
function detach(a: any) {
  if (!working.value || locked.value) return
  const id = working.value.id
  serialize(async () => { if (working.value?.id === id) working.value = await store.detachAudience(id, a.id) }).then(refreshPreview)
}

let pvTimer: any
function refreshPreview() {
  clearTimeout(pvTimer)
  if (!working.value?.audiences?.length) { pv.value = null; return }
  const id = working.value.id
  pvTimer = setTimeout(async () => {
    try { const r = await store.previewDelivery(id); if (working.value?.id === id) pv.value = r } catch { /* ignore */ }
  }, 150)
}

// ── schedule (commit for delivery at the set time) → locks the campaign ──
// The UI never "sends"; it schedules + locks. Delivery is a server-side job at scheduled_at.
async function schedule() {
  if (!schedulable.value || saving.value) return
  let p = pv.value
  try { if (!p) p = await store.previewDelivery(working.value.id) } catch { return }
  const when = [dateValue.value, timeValue.value].filter(Boolean).join(' ')
  // A send time that's already passed is "due" — delivery fires immediately (dry-run or live is a
  // server config; the post-send badge reflects which it was, so the dialog doesn't assert a mode).
  const due = !!working.value.scheduled_at && new Date(working.value.scheduled_at).getTime() <= Date.now()
  const parts = [`~${fmt(p.deliverable)} of ${fmt(p.resolved)} people will receive this ${working.value.channel}`]
  if (p.suppressed) parts.push(`${p.suppressed} suppressed excluded`)
  if (p.no_consent) parts.push(`${p.no_consent} without consent excluded`)
  const lead = due ? `That time has passed, so this delivers immediately` : `Sends ${when ? `on ${when}` : 'at the scheduled time'}`
  confirm.require({
    header: `Schedule “${working.value.name}”?`,
    message: `${lead} — ${parts.join(' · ')}.\nThis locks the campaign for edits (unlock to change it).`,
    icon: 'pi pi-clock',
    acceptProps: { label: 'Schedule' },
    rejectProps: { label: 'Cancel', severity: 'secondary', outlined: true },
    accept: async () => { saving.value = true; try { working.value = { ...working.value, ...(await store.scheduleCampaign(working.value.id, p)) } } finally { saving.value = false } },
  })
}

// Unlock a SCHEDULED campaign back to an editable draft — pull it back before it's delivered.
// (A sent campaign is final: no unlock in the UI; delete it from the rail if you want it gone.)
async function unlock() {
  if (!working.value || !locked.value || saving.value) return
  saving.value = true
  try { working.value = { ...working.value, ...(await store.unlockCampaign(working.value.id)) }; pv.value = null; refreshPreview() }
  finally { saving.value = false }
}

// ── build / open the Analytics performance report (sent campaigns) ──
async function buildReport() {
  if (building.value || !working.value) return
  building.value = true
  try {
    const reportId = await store.buildReport(working.value)   // prompt is the objective-derived analytics_prompt
    working.value.report_id = reportId
    router.push({ name: 'analytics', params: { reportId } })
  } finally { building.value = false }
}
function openReport() { if (working.value?.report_id) router.push({ name: 'analytics', params: { reportId: working.value.report_id } }) }

const pad = (n: number) => String(n).padStart(2, '0')
const localDate = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
const localTime = (iso: string) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
// rail: a campaign's date — when it actually went out (sent) or when it's planned to (scheduled/draft)
function railDate(c: any): string {
  const iso = c?.status === 'sent' ? c.sent_at : c.scheduled_at
  return iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''
}
// Draft shows the planned schedule; a sent campaign shows when it actually went out (sent_at).
const scheduleAt = computed(() => (locked.value ? (working.value?.sent_at || working.value?.scheduled_at) : working.value?.scheduled_at))
const dateValue = computed(() => (scheduleAt.value ? localDate(scheduleAt.value) : ''))
const timeValue = computed(() => (scheduleAt.value && String(scheduleAt.value).includes('T') ? localTime(scheduleAt.value) : ''))
function ago(iso?: string) {
  if (!iso) return ''
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}
</script>

<template>
  <div class="cmp-console">
    <!-- left: saved campaigns -->
    <aside class="cmp-left">
      <div class="pane-head">Campaigns <Button icon="pi pi-plus" text rounded size="small" aria-label="New campaign" @click="startNew" /></div>
      <ul class="rail-list">
        <li v-for="c in filteredCampaigns" :key="c.id" class="rail-item" :class="{ on: c.id === working?.id }" @click="goCampaign(c.id)">
          <div class="ri-main">
            <span class="ri-name">{{ c.name }}</span>
            <span class="ri-sub">{{ c.channel }} · {{ c.status }}<template v-if="railDate(c)"> · {{ railDate(c) }}</template><i v-if="c.status !== 'draft'" class="pi pi-lock lock" /></span>
          </div>
          <button class="ri-x" title="Delete" @click.stop="removeCampaign(c)"><i class="pi pi-times" /></button>
        </li>
        <li v-if="!filteredCampaigns.length" class="rail-empty">{{ q ? 'No matches.' : 'No campaigns yet — start one with +' }}</li>
      </ul>
      <RailSearch v-model="q" placeholder="Search campaigns" />
    </aside>

    <!-- middle: campaign-enabled audiences palette -->
    <aside class="cmp-mid">
      <div class="pane-head">Audiences</div>
      <p class="pane-tip">Click an audience to target it — a campaign reaches the de-duped union of all attached audiences.</p>
      <ul class="rail-list">
        <li v-for="a in palette" :key="a.id" class="seg-pill" :class="{ used: attachedIds.has(a.id), disabled: !working || locked }"
            @click="toggleAudience(a)">
          <i class="pi pi-users" />
          <span class="sp-name">{{ a.name }}</span>
          <i v-if="attachedIds.has(a.id)" class="pi pi-check sp-used" />
        </li>
        <li v-if="!palette.length" class="rail-empty">No campaign-enabled audiences. In Audiences, toggle an audience's “Campaigns” on.</li>
      </ul>
    </aside>

    <!-- center: compose the campaign (content + audiences) -->
    <section class="cmp-center">
      <div v-if="!working" class="cmp-empty">Pick a campaign on the left, or start one with +.</div>

      <div v-else class="builder" :class="{ tall: working.channel === 'email' }">
        <div class="b-head">
          <InputText v-model="draft.name" class="b-name" :disabled="locked" placeholder="Campaign name" />
          <i v-if="locked" class="pi pi-lock lock" title="Locked — unlock to edit" />
        </div>

        <!-- attached audiences -->
        <div class="aud-block">
          <div class="blk-head">Audiences</div>
          <div class="chips">
            <span v-for="a in working.audiences" :key="a.id" class="chip">
              {{ a.name }} <span class="chip-size">~{{ fmt(a.size) }}</span>
              <button v-if="!locked" class="chip-x" title="Remove" @click="detach(a)"><i class="pi pi-times" /></button>
            </span>
            <span v-if="!working.audiences?.length" class="chips-empty">{{ locked ? 'No audiences.' : 'Click audiences in the middle pane to target them.' }}</span>
          </div>
        </div>

        <!-- message -->
        <div class="msg-block">
          <div class="blk-head">Message</div>
          <!-- SMS -->
          <Textarea v-if="working.channel === 'sms'" v-model="draft.message.text" rows="4" autoResize class="sms" :disabled="locked"
            placeholder="Write your SMS… (≤160 chars per segment)" />
          <!-- EMAIL -->
          <template v-else>
            <InputText v-model="draft.subject" class="subj-input" :disabled="locked" placeholder="Email subject" />
            <!-- the editor/preview fills the remaining height of the pane -->
            <div class="msg-body">
              <!-- A FULL HTML document is READ-ONLY output from an external email builder: the UI just
                   previews + ships the compiled HTML (its editable source lives in that tool). Editing
                   it here would be overwritten when it's rebuilt — so we preview it (sandboxed iframe) +
                   offer a read-only source view, never the WYSIWYG (which would also mangle the
                   head/styles/conditionals/tables). -->
              <div v-if="!locked && isFullDoc" class="fulldoc">
                <div class="fulldoc-bar">
                  <span class="fulldoc-tag"><i class="pi pi-file" /> Full HTML email</span>
                  <button type="button" class="src-toggle" @click="fullDocSource = !fullDocSource">{{ fullDocSource ? 'Preview' : 'View source' }}</button>
                </div>
                <iframe v-if="!fullDocSource" class="fulldoc-view" :srcdoc="draft.message.html" sandbox title="Email preview" />
                <Codemirror v-else v-model="draft.message.html" class="fulldoc-view fulldoc-cm" :extensions="cmExtensions"
                  :indent-with-tab="true" :tab-size="2" :autofocus="false" />
              </div>
              <!-- simple UI-authored fragment → TinyMCE WYSIWYG -->
              <Editor v-else-if="!locked" :key="working.id" :model-value="draft.message.html || ''" :init="tinymceInit"
                class="tiny" @update:model-value="onEditorHtml" />
              <iframe v-else class="email-preview" :srcdoc="emailPreviewHtml" sandbox title="Email preview" />
            </div>
          </template>
        </div>

        <!-- save / discard the composed content (shown only when there are unsaved edits) -->
        <div v-if="!locked && dirty" class="save-bar">
          <span class="save-note"><i class="pi pi-circle-fill" /> Unsaved changes</span>
          <Button label="Discard" text severity="secondary" size="small" @click="cancelEdits" />
          <Button label="Save" icon="pi pi-check" size="small" :loading="saving" @click="save" />
        </div>
      </div>
    </section>

    <!-- far-right: send (draft) → results: stats + report configuration (sent) -->
    <aside v-if="working" class="cmp-side">
      <div class="pane-head">{{ paneTitle }}</div>
      <div class="side-body">
        <!-- channel — same UI for both; disabled once sent -->
        <div class="chan-select">
          <label v-for="c in CHANNELS" :key="c.value" class="chan-opt" :class="{ on: working.channel === c.value, off: locked }">
            <input type="radio" name="channel" :value="c.value" :checked="working.channel === c.value" :disabled="locked" @change="setChannel(c.value)" />
            <span class="chan-tx">{{ c.label }}</span>
            <i :class="c.icon" class="chan-ic" />
          </label>
        </div>

        <!-- the number: deliverable preview (draft) → actual sent (locked) -->
        <div class="deliver">
          <div class="dlv-num">{{ metric ? `~${fmt(metric.num)}` : '—' }}</div>
          <div class="dlv-lbl">{{ metric?.label || 'deliverable' }}</div>
          <p v-if="metric" class="dlv-sub"><span v-if="metric.dry" class="dry">dry-run</span>{{ fmt(metric.resolved) }} resolved · {{ fmt(metric.suppressed) }} suppressed</p>
          <p v-else class="dlv-sub">Attach audiences to preview delivery.</p>
        </div>

        <!-- schedule -->
        <div class="row sched-row">
          <label class="fld"><span class="fld-l">Send date</span>
            <input type="date" class="date-input" :value="dateValue" :disabled="locked" @change="setDate" /></label>
          <label class="fld"><span class="fld-l">Send time</span>
            <input type="time" class="date-input" :value="timeValue" :disabled="locked" @change="setTime" /></label>
        </div>

        <!-- objectives (drive the report) -->
        <div class="side-section">
          <div class="blk-head">Objectives</div>
          <p v-if="!locked" class="obj-tip">What is this campaign for? The performance report is built around these.</p>
          <div class="obj-chips">
            <button v-for="o in OBJECTIVES" :key="o" type="button" class="obj-chip" :class="{ on: goals.includes(o) }" :disabled="locked" @click="toggleGoal(o)">{{ o }}</button>
          </div>
          <Textarea v-model="draft.objective.notes" rows="3" autoResize class="obj-notes" :disabled="locked" placeholder="Specific goals (optional) — e.g. re-engage lapsed VIPs, lift average spend…" />
        </div>

        <!-- action: Send (draft) → Open / Build report (sent) -->
        <div class="send-section">
          <template v-if="!locked">
            <Button class="send-btn" label="Schedule" icon="pi pi-clock"
              :loading="saving" :disabled="!schedulable" @click="schedule" />
            <p v-if="dirty" class="hint">Save your changes first.</p>
            <p v-else-if="!working.audiences?.length" class="hint">Attach an audience first.</p>
            <p v-else-if="!ready" class="hint">{{ working.channel === 'sms' ? 'Write the SMS first.' : 'Write the email first.' }}</p>
            <p v-else-if="!working.scheduled_at" class="hint">Set a send date &amp; time above.</p>
            <p v-else class="hint">Scheduling commits delivery for that time and locks the campaign — unlock to change it.</p>
          </template>
          <template v-else-if="working.status === 'sent'">
            <!-- delivered: a final record. No unlock — you can't un-send. Only the report. -->
            <Button v-if="working.report_id" class="send-btn" label="Open report" icon="pi pi-chart-bar" @click="openReport" />
            <Button v-else class="send-btn" label="Build report" icon="pi pi-sparkles" :loading="building" @click="buildReport" />
            <p class="hint">{{ working.report_id ? 'Performance report built from the objectives above.' : 'Delivered — build a performance report from the objectives above.' }}</p>
          </template>
          <template v-else>
            <!-- scheduled but not yet delivered: nothing to report on yet -->
            <Button class="unlock-btn solo" label="Unlock to edit" icon="pi pi-lock-open" text severity="secondary" :loading="saving" @click="unlock" />
            <p class="hint"><i class="pi pi-clock" /> Scheduled{{ dateValue ? ` for ${dateValue}${timeValue ? ` ${timeValue}` : ''}` : '' }} — locked. The performance report becomes available once it’s delivered.</p>
          </template>
        </div>
      </div>
    </aside>
    <ConfirmDialog />
  </div>
</template>

<style scoped>
.cmp-console { display: flex; height: 100%; min-height: 0; }
.cmp-left, .cmp-mid { flex: none; display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); background: var(--panel); }
.cmp-left { width: 300px; } .cmp-mid { width: 300px; }
.cmp-center { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; padding: 22px 26px; overflow: auto; background: var(--bg); }
.cmp-side { flex: none; width: 320px; min-height: 0; display: flex; flex-direction: column; border-left: 1px solid var(--border); background: var(--panel); }
.side-body { flex: 1 1 auto; overflow: auto; padding: 18px; }
.cmp-empty { margin: auto; color: var(--muted); font-size: 14px; }

.pane-head { height: 52px; flex: none; padding: 0 8px 0 18px; gap: 8px; font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
.pane-tip { margin: 0; padding: 12px 16px 2px; font-size: 12.5px; line-height: 1.5; color: var(--muted); }
.rail-list { list-style: none; margin: 0; padding: 8px 8px 16px; overflow: auto; flex: 1 1 auto; min-height: 0; }
.rail-empty { padding: 14px 10px; font-size: 12px; color: var(--muted); line-height: 1.5; }

.rail-item { display: flex; align-items: center; gap: 6px; padding: 9px 10px; border-radius: 8px; cursor: pointer; }
.rail-item:hover { background: var(--panel-2); }
.rail-item.on { background: var(--accent-soft); }
.rail-item.on .ri-name { color: var(--accent); }
.ri-main { flex: 1 1 auto; min-width: 0; }
.ri-name { display: block; font-size: 14px; font-weight: 600; color: var(--text-strong); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ri-sub { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--muted); text-transform: capitalize; }
.lock { font-size: 10px; color: var(--muted); }
.ri-x { border: none; background: none; color: var(--muted); cursor: pointer; opacity: 0; font-size: 12px; }
.rail-item:hover .ri-x { opacity: 1; } .ri-x:hover { color: var(--text-strong); }

.seg-pill { display: flex; align-items: center; gap: 8px; padding: 8px 10px; margin-bottom: 6px; border: 1px solid var(--border); border-radius: 8px; cursor: pointer; background: var(--panel); }
.seg-pill:hover { border-color: var(--border-2); }
.seg-pill.used { border-color: var(--accent); background: var(--accent-soft); }
.seg-pill.disabled { opacity: .5; pointer-events: none; }
.seg-pill .pi-users { font-size: 12px; color: var(--accent); }
.sp-name { flex: 1 1 auto; min-width: 0; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sp-used { font-size: 11px; color: var(--accent); }

.builder { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 18px 20px; width: 100%; display: flex; flex-direction: column; min-height: 0; }
.builder.tall { flex: 1 1 auto; }   /* email: builder fills the pane height so the editor can too */
.b-head { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.b-name { flex: 1 1 auto; min-width: 0; font-size: 16px; font-weight: 650; }
.b-name-static { flex: 1 1 auto; margin: 0; font-size: 18px; font-weight: 650; color: var(--text-strong); display: flex; align-items: center; gap: 8px; }
.chan-static { font-size: 12px; color: var(--muted); text-transform: capitalize; }

.row { display: flex; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
.fld { display: flex; flex-direction: column; gap: 5px; } .fld.grow { flex: 1 1 220px; }
.fld-l { font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
.fld :deep(input), .date-input { width: 100%; }
.date-input { border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; font: inherit; font-size: 13px; color: var(--text-strong); background: var(--panel); }

.blk-head { font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); margin-bottom: 8px; }
.aud-block, .msg-block, .obj-block { margin-bottom: 18px; }
/* email: the message area grows to fill the builder; the editor/preview fills it in turn */
.msg-block { display: flex; flex-direction: column; }
.builder.tall .msg-block { flex: 1 1 auto; min-height: 0; margin-bottom: 0; }
.msg-body { flex: 1 1 auto; min-height: 220px; }
/* objectives — goal chips + notes; drive the AI report */
.obj-tip { margin: 0 0 8px; font-size: 12px; color: var(--muted); line-height: 1.5; }
.obj-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
.obj-chip { border: 1px solid var(--border); background: var(--panel); border-radius: 999px; padding: 5px 12px; font: inherit; font-size: 12.5px; cursor: pointer; color: var(--text); transition: border-color .12s, background .12s, color .12s; }
.obj-chip:hover { border-color: var(--border-2); }
.obj-chip.on { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); font-weight: 600; }
/* read-only (sent): the chosen objectives stay highlighted; the rest dim so they stand out */
.obj-chip:disabled { cursor: default; }
.obj-chip:disabled:not(.on) { opacity: .4; }
.obj-notes { width: 100%; }
.obj-readonly { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.obj-tag { font-size: 12px; font-weight: 600; color: var(--accent); background: var(--accent-soft); border-radius: 999px; padding: 3px 10px; }
.obj-note-ro { font-size: 12.5px; color: var(--text); }
/* read-only (sent) variants of the composed fields */
.subj-static { font-size: 14px; font-weight: 550; color: var(--text-strong); }
.sms-static { margin: 0; font-size: 13.5px; line-height: 1.55; color: var(--text); white-space: pre-wrap; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 5px 8px 5px 11px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 999px; font-size: 12.5px; font-weight: 550; color: var(--text-strong); }
.chip-size { font-size: 11px; color: var(--muted); font-weight: 400; }
.chip-x { border: none; background: none; cursor: pointer; color: var(--muted); font-size: 11px; padding: 0; }
.chip-x:hover { color: var(--text-strong); }
.chips-empty { font-size: 12.5px; color: var(--muted); }

.sms { width: 100%; }
.subj-input { width: 100%; margin-bottom: 12px; }
.save-bar { display: flex; align-items: center; gap: 10px; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border); }
.save-note { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--muted); margin-right: auto; }
.save-note .pi-circle-fill { font-size: 8px; color: #d97706; }
/* TinyMCE renders its chrome as a SIBLING of the (hidden) textarea, so we must scope from
   .cmp-center (a real ancestor), not the editor element. Round the frame, and collapse the skin's
   wide group padding (~23px each — the "separator") so the full toolbar fits one row in the narrow
   pane. !important to beat the skin css. */
.cmp-center :deep(.tox-tinymce) { border: 1px solid var(--p-inputtext-border-color) !important; border-radius: 6px; height: 100% !important; }
.cmp-center :deep(.tox-toolbar__group) { padding: 0 1px !important; }
/* the right edge already sits ~13px in; pad the first group's left to match so both align with the
   content inset below (the left was nearly flush after the group-padding collapse) */
.cmp-center :deep(.tox-toolbar__group:first-child) { padding-left: 12px !important; }
.cmp-center :deep(.tox-tbtn) { margin: 2px 0 !important; }
/* shave icon buttons a touch (NOT the text "Heading" dropdown) so the full set + source fit one row */
.cmp-center :deep(.tox-tbtn:not(.tox-tbtn--bespoke)) { width: 29px !important; }
/* flat — drop the skin's drop-shadow under the toolbar */
.cmp-center :deep(.tox-editor-header) { box-shadow: none !important; }
/* focus: behave like the inputs — drop TinyMCE's blue ring, darken the border + show the same
   focus ring (PrimeVue tokens) when editing */
.cmp-center :deep(.tox-edit-area::before) { display: none !important; }
.cmp-center :deep(.tox-tinymce.tox-edit-focus),
.cmp-center :deep(.tox-tinymce:focus-within) {
  border-color: var(--p-inputtext-focus-border-color) !important;
  outline: var(--p-focus-ring-width) var(--p-focus-ring-style) var(--p-focus-ring-color);
  outline-offset: var(--p-focus-ring-offset);
}
.email-preview { width: 100%; height: 100%; border: 1px solid var(--border); border-radius: 10px; background: #fff; display: block; }
/* full HTML email (external builder output) — previewed/source-viewed, never sent through the WYSIWYG */
.fulldoc { border: 1px solid var(--border); border-radius: 6px; overflow: hidden; height: 100%; display: flex; flex-direction: column; }
.fulldoc-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 7px 10px 7px 12px; background: var(--panel-2); border-bottom: 1px solid var(--border); }
.fulldoc-tag { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--muted); }
.fulldoc .src-toggle { font-size: 12px; font-weight: 600; color: var(--text); background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 3px 10px; cursor: pointer; white-space: nowrap; }
.fulldoc-view { width: 100%; flex: 1 1 auto; min-height: 0; border: none; display: block; background: #fff; }
/* CodeMirror source editor — fills the frame, HTML-highlighted, editable */
.fulldoc-cm { display: flex; flex-direction: column; overflow: hidden; background: #fff; }
.fulldoc-cm :deep(.cm-editor) { flex: 1 1 auto; height: 100%; font-size: 12.5px; }
.fulldoc-cm :deep(.cm-editor.cm-focused) { outline: none; }
.fulldoc-cm :deep(.cm-scroller) { overflow: auto; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

/* far-right SEND pane (draft) */
.chan-select { margin-bottom: 18px; }
.chan-opt { display: flex; align-items: center; gap: 9px; padding: 8px 11px; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 6px; cursor: pointer; font-size: 13px; font-weight: 550; color: var(--text-strong); }
.chan-opt:hover { border-color: var(--border-2); }
.chan-opt.off { cursor: default; }
.chan-opt.off:hover { border-color: var(--border); }
.chan-opt.off:not(.on) { opacity: .55; }
.chan-opt.on { border-color: var(--accent); background: var(--accent-soft); }
.chan-opt input { accent-color: var(--accent); margin: 0; }
.chan-tx { flex: 1 1 auto; }
.chan-ic { font-size: 13px; color: var(--muted); }
.chan-opt.on .chan-ic { color: var(--accent); }
.deliver { display: flex; flex-direction: column; align-items: flex-start; margin-bottom: 14px; }
.dlv-num { font-size: 30px; font-weight: 700; line-height: 1; color: var(--text-strong); }
.dlv-lbl { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; margin-top: 3px; }
.dlv-sub { margin: 8px 0 0; font-size: 12px; color: var(--muted); }
.sched-row { gap: 10px; margin: 14px 0 16px; }
.sched-row .fld { flex: 1 1 0; min-width: 0; }
.send-section { margin-top: 18px; }
.send-btn { width: 100%; }
.unlock-btn { width: 100%; margin-top: 8px; }
.unlock-btn.solo { margin-top: 0; }
.hint { display: block; margin: 10px 0 0; font-size: 12px; color: var(--muted); line-height: 1.5; }
.side-section { border-top: 1px solid var(--border); margin-top: 16px; padding-top: 16px; }

/* far-right RESULTS pane (sent) */
.stats { display: flex; align-items: baseline; gap: 18px; flex-wrap: wrap; margin: 2px 0 6px; }
.stat { display: flex; flex-direction: column; gap: 2px; }
.s-num { font-size: 26px; font-weight: 700; line-height: 1; color: var(--text-strong); }
.s-lbl { font-size: 10.5px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
.dry { display: inline-block; font-size: 10px; font-weight: 700; color: var(--muted); background: var(--panel-2); border: 1px solid var(--border); border-radius: 999px; padding: 1px 8px; margin-right: 6px; }
.sent-meta { font-size: 12.5px; color: var(--muted); margin: 0 0 18px; }
.report-block { border-top: 1px solid var(--border); padding-top: 16px; }
.rep-tip { padding: 0; margin: 0 0 10px; }
.prompt { width: 100%; margin-bottom: 10px; }
</style>
