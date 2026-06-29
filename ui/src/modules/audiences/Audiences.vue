<script setup lang="ts">
// Audiences module — same three-pane logic as analytics:
//   left  = saved audiences (pick / + New)
//   mid   = segments palette (the building blocks — drag or click into the rule)
//   right = the open audience: AND/OR/NOT composition + live size + activation
// An audience is a boolean composition of segments, resolved live at apply-time.
import { ref, computed, watch, nextTick, onActivated } from 'vue'
import { storeToRefs } from 'pinia'
import { useRoute, useRouter } from 'vue-router'
import { useConfirm } from 'primevue/useconfirm'
import ConfirmDialog from 'primevue/confirmdialog'
import Button from 'primevue/button'
import RailSearch from '../../components/RailSearch.vue'
import { useAudiencesStore } from '../analytics/stores/audiences'

const confirm = useConfirm()
const route = useRoute()
const router = useRouter()
const paramStr = (p: any): string => (Array.isArray(p) ? p[0] : p) || ''
const store = useAudiencesStore()
const { segments, audiences, networks } = storeToRefs(store)
// client-side rail search
const q = ref('')
const filteredAudiences = computed(() => {
  const s = q.value.trim().toLowerCase()
  return s ? audiences.value.filter((a: any) => (a.name || '').toLowerCase().includes(s)) : audiences.value
})

// the audience currently open in the builder — a local working copy of its rule
const working = ref<{ id: string | null; name: string; activation_id: string; op: 'all' | 'any'; members: { segment: string; negate: boolean }[]; delivery: Record<string, any>; client_side: boolean; campaigns: boolean }>(
  { id: null, name: 'Untitled audience', activation_id: '', op: 'all', members: [], delivery: {}, client_side: false, campaigns: false },
)
const idEdited = ref(false)   // once the user types an activation id, stop auto-deriving it from the name
const nameEdited = ref(false) // once the user types a name, stop auto-naming from the composition
const slugify = (s: string) => (s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
function onName() { nameEdited.value = true; dirty.value = true; if (!idEdited.value) working.value.activation_id = slugify(working.value.name) }
function onActivationId(e: Event) { idEdited.value = true; dirty.value = true; working.value.activation_id = slugify((e.target as HTMLInputElement).value) }
const dirty = ref(false)
const saving = ref(false)
const size = ref<number | null>(null)
const sizing = ref(false)

// segment id → its row (name) and its lazily-previewed size, for display in the palette + chips
const segById = computed(() => new Map(segments.value.map((s: any) => [s.id, s])))
const segSizes = ref<Record<string, number | null>>({})
const segName = (id: string) => segById.value.get(id)?.name || 'Segment'
const usedIds = computed(() => new Set(working.value.members.map(m => m.segment)))

// at least one non-negated member → the rule is resolvable (a NOT-only rule has no base)
const hasPositive = computed(() => working.value.members.some(m => !m.negate))
const rule = computed(() => ({ op: working.value.op, members: working.value.members.map(m => ({ segment: m.segment, ...(m.negate ? { negate: true } : {}) })) }))

// onActivated (not onMounted): the module is kept-alive, so onMounted fires only once and a
// missed first load would leave the panes blank until a full refresh. onActivated runs on the
// first show AND every re-entry — so the lists always load, and segments created over in
// Analytics show up when you switch here. Cheap: only un-sized segments are previewed.
onActivated(async () => {
  await Promise.all([store.loadSegments(), store.loadAudiences(), store.loadNetworks()])
  segments.value.forEach((s: any) => {
    if (segSizes.value[s.id] != null) return
    store.previewSegment(s.source)
      .then((r: any) => { segSizes.value = { ...segSizes.value, [s.id]: r?.est_matches ?? null } })
      .catch(() => {})
  })
})

// ── audience selection ──
function openAudience(a: any) {
  working.value = { id: a.id, name: a.name, activation_id: a.activation_id || '', op: a.rule?.op || 'all', members: (a.rule?.members || []).map((m: any) => ({ segment: m.segment, negate: !!m.negate })), delivery: a.delivery || {}, client_side: !!a.client_side, campaigns: !!a.campaigns }
  idEdited.value = true   // a saved activation id is authoritative — don't overwrite it from the name
  nameEdited.value = true // a saved name is authoritative too — editing the rule won't silently rename it
  dirty.value = false
}
function newAudience() {
  working.value = { id: null, name: 'Untitled audience', activation_id: '', op: 'all', members: [], delivery: {}, client_side: false, campaigns: false }
  idEdited.value = false; nameEdited.value = false; dirty.value = false; size.value = null
}

// ── routing: the open audience lives in the URL (/audiences/:audienceId). Clicks push
// routes; this turns the route back into the open builder. Kept-alive across module
// switches, so guard to this module's route. Re-runs when the list loads (deep links). ──
function applyRoute() {
  if (route.name !== 'audiences') return
  const id = paramStr(route.params.audienceId)
  if (!id) { if (working.value.id) newAudience(); return }   // no id → blank builder (don't wipe an in-progress new one)
  if (working.value.id === id) return                        // already open
  const found = audiences.value.find((a: any) => a.id === id)
  if (found) openAudience(found)
}
watch([() => route.params.audienceId, audiences], applyRoute, { immediate: true })
function goAudience(id: string) { router.push({ name: 'audiences', params: { audienceId: id } }) }
function startNew() { router.push({ name: 'audiences', params: {} }) }

// ── rule edits (add via drag or click; toggle AND/NOT; remove) ──
const isEveryone = (id: string) => { const s: any = segById.value.get(id); return !!(s?.origin?.system || s?.name === 'Everyone') }
// ── inline rename of a segment (palette) ──
const editingId = ref<string | null>(null)
const editName = ref('')
function startRename(s: any) {
  editingId.value = s.id; editName.value = s.name
  nextTick(() => { const el = document.querySelector('.sp-edit') as HTMLInputElement | null; el?.focus(); el?.select() })
}
function cancelRename() { editingId.value = null }
async function commitRename(s: any) {
  const wasEditing = editingId.value === s.id
  const name = editName.value.trim()
  editingId.value = null
  if (!wasEditing || !name || name === s.name) return
  try { await store.renameSegment(s.id, name) } catch { /* keep the old name on failure */ }
}

function addMember(segmentId: string) {
  if (editingId.value) return
  if (!segmentId || usedIds.value.has(segmentId)) return
  // "Everyone AND segment" is just the segment; the useful pattern is "Everyone AND NOT
  // segment", so once Everyone anchors the audience, new segments come in as exclusions.
  const negate = !isEveryone(segmentId) && working.value.members.some(m => isEveryone(m.segment))
  working.value.members.push({ segment: segmentId, negate }); dirty.value = true
}
function removeMember(i: number) { working.value.members.splice(i, 1); dirty.value = true }
function toggleNegate(m: any) { m.negate = !m.negate; dirty.value = true }
function setOp(op: 'all' | 'any') { working.value.op = op; dirty.value = true }

// native drag-drop: a segment from the palette → the rule drop zone
const draggingId = ref<string | null>(null)
const dropActive = ref(false)
function onDrop() { if (draggingId.value) addMember(draggingId.value); draggingId.value = null; dropActive.value = false }

// ── live size: re-preview whenever the rule changes (debounced) ──
let pvTimer: any
watch(rule, () => {
  clearTimeout(pvTimer)
  if (!hasPositive.value) { size.value = null; sizing.value = false; return }
  sizing.value = true
  pvTimer = setTimeout(async () => {
    const snapshot = JSON.stringify(rule.value)
    try { const r = await store.previewAudience(rule.value); if (snapshot === JSON.stringify(rule.value)) { size.value = r?.est_matches ?? null; sizing.value = false } }
    catch { sizing.value = false }
  }, 300)
}, { deep: true, immediate: true })

// ── auto-name: until the user types a name of their own, name the audience from its
// composition on every rule change (the AI labels include/exclude segment names + match
// mode). Debounced — it's an AI call. The activation id keeps following the name. ──
let nameTimer: any
watch(rule, () => {
  if (nameEdited.value) return
  clearTimeout(nameTimer)
  if (!working.value.members.length) {                          // empty rule → back to the placeholder name
    working.value.name = 'Untitled audience'
    if (!idEdited.value) working.value.activation_id = ''
    return
  }
  nameTimer = setTimeout(async () => {
    if (nameEdited.value) return
    const snapshot = JSON.stringify(rule.value)
    try {
      const r = await store.nameAudience(rule.value)
      if (nameEdited.value || snapshot !== JSON.stringify(rule.value)) return   // user named it, or the rule moved on
      if (r?.name) { working.value.name = r.name; if (!idEdited.value) working.value.activation_id = slugify(r.name) }
    } catch { /* keep the current name on failure */ }
  }, 700)
}, { deep: true })

async function save() {
  if (!hasPositive.value || saving.value) return
  saving.value = true
  try {
    const row = await store.saveAudience({ id: working.value.id || undefined, name: working.value.name?.trim() || 'Untitled audience', activation_id: working.value.activation_id || undefined, rule: rule.value })
    working.value.id = row.id; working.value.activation_id = row.activation_id || ''; dirty.value = false   // backend may have deduped it
    if (paramStr(route.params.audienceId) !== row.id) router.replace({ name: 'audiences', params: { audienceId: row.id } })   // reflect the new id in the URL
  } finally { saving.value = false }
}
function removeAudience(a: any) {
  confirm.require({
    header: 'Delete audience', message: `Delete “${a.name}”? This can’t be undone.`, icon: 'pi pi-trash',
    defaultFocus: 'reject', acceptProps: { label: 'Delete', severity: 'danger' }, rejectProps: { label: 'Cancel', severity: 'secondary', outlined: true },
    accept: async () => { const wasOpen = working.value.id === a.id; await store.removeAudience(a.id); if (wasOpen) startNew() },
  })
}
const fmt = (n: number | null) => (n == null ? '—' : n.toLocaleString())

// ── delivery / activation ──
// Display metadata (label + brand dot) for the ad networks we support — the server's
// /networks doesn't carry branding. The CONNECTION status comes from the server, though:
// a network is deliverable only if it reports a configured, eligible adapter.
const NETWORK_META: Record<string, { label: string; dot: string }> = {
  meta: { label: 'Meta Ads', dot: '#185FA5' },
  google: { label: 'Google Ads', dot: '#3B6D11' },
  tiktok: { label: 'TikTok Ads', dot: '#9333ea' },
}
// supported networks ∪ any extra adapter the server reports, each with its live status.
// `connected` (an eligible server adapter) decides live toggle vs "Connect" prompt — so a
// network without a configured adapter can never be toggled into a silent dry-run.
const channels = computed(() => {
  const nets = networks.value || []
  const byName = new Map(nets.map((n: any) => [n.name, n]))
  const names = [...new Set([...Object.keys(NETWORK_META), ...nets.map((n: any) => n.name)])]
  return names.map(name => {
    const meta = NETWORK_META[name] || { label: name.charAt(0).toUpperCase() + name.slice(1), dot: 'var(--border-2)' }
    return { name, label: meta.label, dot: meta.dot, connected: byName.get(name)?.eligible === true }
  })
})
function ago(iso?: string) {
  if (!iso) return ''
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}
function netStatus(n: any) {                                  // only shown for connected networks
  const d = working.value.delivery?.[n.name]
  if (d?.enabled) return `live · synced ${ago(d.last_synced_at)}${d.dry_run ? ' · dry-run' : ''}`
  if (d?.last_synced_at) return `off · last synced ${ago(d.last_synced_at)}`
  return 'connected · not delivering'
}
const netOn = (n: any) => !!working.value.delivery?.[n.name]?.enabled

// A network with no configured server adapter: there's no live connect flow in-app (the
// adapter + credentials are set up server-side), so explain that rather than fake a toggle.
function connectNetwork(ch: any) {
  confirm.require({
    header: `Connect ${ch.label}`,
    message: `${ch.label} has no delivery adapter configured on the server yet. Add its CAPI adapter (with credentials) to the audiences plugin config — it then appears here as a live delivery toggle.`,
    icon: 'pi pi-link',
    acceptProps: { label: 'Got it' },
    rejectProps: { style: 'display:none' },
  })
}

// Client-side availability — whether the on-site SDK can read this audience's membership.
// First-party + immediate (no confirm): nothing leaves to a third party, it just flips a
// flag the membership endpoint honours. Must be saved first (the client reads by activation id).
async function toggleClientSide() {
  if (!hasPositive.value || saving.value) return
  if (!working.value.id || dirty.value) await save()
  const row = await store.setClientSide(working.value.id!, !working.value.client_side)
  working.value.client_side = !!row.client_side
}

// Campaigns availability — whether this audience can be picked as a send target in the
// Campaigns module (email & SMS). First-party + immediate, like client-side.
async function toggleCampaigns() {
  if (!hasPositive.value || saving.value) return
  if (!working.value.id || dirty.value) await save()
  const row = await store.setCampaigns(working.value.id!, !working.value.campaigns)
  working.value.campaigns = !!row.campaigns
}

// Toggling delivery. Turning OFF is immediate (safe). Turning ON previews the
// deliverable cohort and asks before any data leaves to the network.
async function toggleNetwork(n: any) {
  if (!hasPositive.value || saving.value) return
  if (!working.value.id || dirty.value) await save()          // must be saved to deliver
  const id = working.value.id!
  if (netOn(n)) { const row = await store.setDelivery(id, n.name, false); working.value.delivery = row.delivery || {}; return }
  let pv: any
  try { pv = await store.previewDelivery(id) } catch { return }
  const parts = [`${fmt(pv.deliverable)} of ${fmt(pv.resolved)} people will be shared via CAPI`]
  if (pv.suppressed) parts.push(`${pv.suppressed} suppressed excluded`)
  if (pv.no_consent) parts.push(`${pv.no_consent} without consent excluded`)
  confirm.require({
    header: `Send to ${n.label}?`,
    message: `${parts.join(' · ')}.\nShares hashed email / phone. Re-resolves and re-syncs hourly while delivery is on.`,
    icon: 'pi pi-bolt',
    acceptProps: { label: `Send ${fmt(pv.deliverable)}` },
    rejectProps: { label: 'Cancel', severity: 'secondary', outlined: true },
    accept: async () => { const row = await store.setDelivery(id, n.name, true); working.value.delivery = row.delivery || {} },
  })
}
</script>

<template>
  <div class="aud-console">
    <!-- left: saved audiences -->
    <aside class="aud-left">
      <div class="pane-head">Audiences <Button icon="pi pi-plus" text rounded size="small" aria-label="New audience" @click="startNew" /></div>
      <ul class="rail-list">
        <li v-for="a in filteredAudiences" :key="a.id" class="rail-item" :class="{ on: a.id === working.id }" @click="goAudience(a.id)">
          <div class="ri-main">
            <span class="ri-name">{{ a.name }}</span>
            <span class="ri-sub">{{ (a.rule?.members?.length || 0) }} segment{{ (a.rule?.members?.length||0) === 1 ? '' : 's' }} · {{ a.rule?.op === 'any' ? 'any' : 'all' }}</span>
          </div>
          <button class="ri-x" title="Delete" @click.stop="removeAudience(a)"><i class="pi pi-times" /></button>
        </li>
        <li v-if="!filteredAudiences.length" class="rail-empty">{{ q ? 'No matches.' : 'No audiences yet — start one with +' }}</li>
      </ul>
      <RailSearch v-model="q" placeholder="Search audiences" />
    </aside>

    <!-- middle: segments palette -->
    <aside class="aud-mid">
      <div class="pane-head">Segments</div>
      <p class="pane-tip">Drag or click a segment into the rule.</p>
      <ul class="rail-list">
        <li v-for="s in segments" :key="s.id" class="seg-pill" :class="{ used: usedIds.has(s.id), editing: editingId === s.id }"
            :draggable="editingId !== s.id" @dragstart="draggingId = s.id" @dragend="draggingId = null" @click="addMember(s.id)">
          <i class="pi pi-bookmark" />
          <input v-if="editingId === s.id" class="sp-edit" v-model="editName" @click.stop
            @keyup.enter="commitRename(s)" @keyup.esc="cancelRename" @blur="commitRename(s)" />
          <span v-else class="sp-name">{{ s.name }}</span>
          <span class="sp-size">{{ segSizes[s.id] != null ? `~${fmt(segSizes[s.id])}` : '' }}</span>
          <i v-if="usedIds.has(s.id)" class="pi pi-check sp-used" />
          <button v-if="editingId !== s.id" class="sp-rename" title="Rename" @click.stop="startRename(s)"><i class="pi pi-pencil" /></button>
        </li>
        <li v-if="!segments.length" class="rail-empty">No segments yet — create them from a chart in Analytics.</li>
      </ul>
    </aside>

    <!-- right: the composition + activation -->
    <section class="aud-right">
      <div class="builder">
        <div class="b-head">
          <input v-model="working.name" class="b-name" placeholder="Audience name" @input="onName" />
          <div class="b-size">
            <span class="bs-num">{{ hasPositive ? (sizing ? '…' : `~${fmt(size)}`) : '—' }}</span><span class="bs-lbl">people</span>
          </div>
        </div>
        <div class="b-rulebar">
          <span class="b-op">
            <button :class="{ on: working.op === 'all' }" @click="setOp('all')">Match all</button>
            <button :class="{ on: working.op === 'any' }" @click="setOp('any')">Match any</button>
          </span>
          <span class="b-resolve"><i class="pi pi-refresh" /> resolved live at delivery</span>
        </div>

        <!-- the rule: segment members + AND/NOT, a drop target -->
        <div class="b-rule" :class="{ drop: dropActive }"
             @dragover.prevent="dropActive = true" @dragleave="dropActive = false" @drop.prevent="onDrop">
          <template v-for="(m, i) in working.members" :key="m.segment">
            <span v-if="i > 0" class="op-join">{{ working.op === 'any' ? 'or' : 'and' }}</span>
            <span class="mem" :class="{ neg: m.negate }">
              <button class="mem-neg" :class="{ on: m.negate }" v-tooltip.top="m.negate ? 'Excluded — click to include' : 'Included — click to exclude'" :aria-label="m.negate ? 'Excluded' : 'Included'" @click="toggleNegate(m)"><i :class="m.negate ? 'pi pi-ban' : 'pi pi-check'" /></button>
              <span class="mem-name">{{ segName(m.segment) }}</span>
              <span class="mem-size">{{ segSizes[m.segment] != null ? `~${fmt(segSizes[m.segment])}` : '' }}</span>
              <button class="mem-x" v-tooltip.top="'Remove'" aria-label="Remove" @click="removeMember(i)"><i class="pi pi-times" /></button>
            </span>
          </template>
          <span v-if="!working.members.length" class="b-empty">Drag segments here (or click them) to compose this audience</span>
        </div>

        <div class="b-actions">
          <Button :label="working.id ? 'Save changes' : 'Create audience'" size="small" :loading="saving" :disabled="!hasPositive || (!dirty && !!working.id)" @click="save" />
          <span v-if="working.id && !dirty" class="b-saved"><i class="pi pi-check" /> saved</span>
        </div>
      </div>
    </section>

    <!-- far-right: activation is its own pane. Standing on/off per network; the actual
         CAPI send is gated by an explicit confirm (preview of the deliverable cohort). -->
    <aside class="aud-activation">
      <div class="pane-head">Activation</div>
      <div class="act-body">
        <p class="pane-tip act-tip">Activate this audience across channels — re-resolved fresh on every sync.</p>
        <!-- activation id — the stable id the client side reads (membership lookup) -->
        <div class="actid-field">
          <label class="actid-label" for="aud-actid">Activation ID</label>
          <div class="actid-input"><input id="aud-actid" :value="working.activation_id" placeholder="activation-id" spellcheck="false" @input="onActivationId" /></div>
          <p class="actid-hint">The id this audience is delivered as — the custom-audience key sent to the ad networks (CAPI), and what the client side reads for membership.</p>
        </div>

        <!-- on-site (client SDK) — a first-party channel: it only exposes membership for your
             own site/app to read (by activation id). Immediate, no third-party send. -->
        <div class="chan-head">On-site</div>
        <div class="net-row first">
          <span class="dot" :class="{ off: !working.client_side }" :style="working.client_side ? { background: 'var(--accent)' } : {}" />
          <div class="net-main">
            <div class="net-name" :class="{ muted: !working.client_side }">On-site</div>
            <div class="net-sub">{{ working.client_side ? 'readable on your site by activation id' : 'hidden from the client side' }}</div>
          </div>
          <button type="button" class="sw" :class="{ on: working.client_side }" :disabled="!hasPositive" aria-label="Toggle client-side availability" @click="toggleClientSide"><i /></button>
        </div>

        <!-- ad networks (CAPI) — driven by the server's configured adapters. Connected →
             a live delivery toggle (third-party send, gated by an explicit confirm);
             not connected → a Connect prompt, never a silent dry-run. -->
        <div class="chan-head">Ad networks</div>
        <div v-for="(ch, ci) in channels" :key="ch.name" class="net-row" :class="{ first: ci === 0 }">
          <span class="dot" :class="{ off: !ch.connected || !netOn(ch) }" :style="(ch.connected && netOn(ch)) ? { background: ch.dot } : {}" />
          <div class="net-main">
            <div class="net-name" :class="{ muted: !ch.connected || !netOn(ch) }">{{ ch.label }}</div>
            <div class="net-sub">{{ ch.connected ? netStatus(ch) : 'not connected' }}<span v-if="ch.connected && netOn(ch) && working.delivery?.[ch.name]?.last_count != null"> · {{ fmt(working.delivery[ch.name].last_count) }} sent</span></div>
          </div>
          <button v-if="ch.connected" type="button" class="sw" :class="{ on: netOn(ch) }" :disabled="!hasPositive" :aria-label="`Toggle ${ch.label}`" @click="toggleNetwork(ch)"><i /></button>
          <button v-else type="button" class="net-connect" @click="connectNetwork(ch)">Connect</button>
        </div>
        <!-- campaigns — your own email & SMS sends. First-party + immediate, like on-site. -->
        <div class="chan-head">Campaigns</div>
        <div class="net-row first">
          <span class="dot" :class="{ off: !working.campaigns }" :style="working.campaigns ? { background: 'var(--accent)' } : {}" />
          <div class="net-main">
            <div class="net-name" :class="{ muted: !working.campaigns }">Email &amp; SMS</div>
            <div class="net-sub">{{ working.campaigns ? 'available as a Campaigns send target' : 'not used by Campaigns' }}</div>
          </div>
          <button type="button" class="sw" :class="{ on: working.campaigns }" :disabled="!hasPositive" aria-label="Toggle Campaigns availability" @click="toggleCampaigns"><i /></button>
        </div>

        <p v-if="!hasPositive" class="act-hint">Compose an audience to enable delivery.</p>
        <p v-else-if="!working.id" class="act-hint">Toggling a channel saves the audience first.</p>
      </div>
    </aside>
    <ConfirmDialog />
  </div>
</template>

<style scoped>
.aud-console { display: flex; height: 100%; min-height: 0; }
.aud-left, .aud-mid { flex: none; display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); background: var(--panel); }
.aud-left { width: 300px; } .aud-mid { width: 300px; }
.aud-right { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 18px; padding: 22px 26px; overflow: auto; }
.aud-activation { flex: none; width: 300px; min-height: 0; display: flex; flex-direction: column; overflow: hidden; border-left: 1px solid var(--border); background: var(--panel); }

/* pane header — matches the analytics reports pane (.pane-head): a 52px bar with a
   bottom border, uppercase muted title, space-between */
.pane-head { height: 52px; flex: none; padding: 0 8px 0 18px; gap: 8px; font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
/* helper tip in the panel body (not the header) — like the analytics agent hint */
.pane-tip { margin: 0; padding: 12px 16px 2px; font-size: 12.5px; line-height: 1.5; color: var(--muted); }
.act-tip { padding: 0; margin: 0 0 14px; }
.rail-list { list-style: none; margin: 0; padding: 8px 8px 16px; overflow: auto; }
.aud-left .rail-list { flex: 1 1 auto; min-height: 0; }   /* list fills so the rail search sits at the bottom */
.rail-empty { padding: 14px 10px; font-size: 12px; color: var(--muted); line-height: 1.5; }

.rail-item { display: flex; align-items: center; gap: 6px; padding: 9px 10px; border-radius: 8px; cursor: pointer; }
.rail-item:hover { background: var(--panel-2); }
.rail-item.on { background: var(--accent-soft); }
.rail-item.on .ri-name { color: var(--accent); }
.ri-main { flex: 1 1 auto; min-width: 0; }
.ri-name { display: block; font-size: 14px; font-weight: 600; color: var(--text-strong); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ri-sub { display: block; font-size: 11px; color: var(--muted); }
.ri-x { border: none; background: none; color: var(--muted); cursor: pointer; opacity: 0; font-size: 12px; }
.rail-item:hover .ri-x { opacity: 1; } .ri-x:hover { color: var(--text-strong); }

.seg-pill { position: relative; display: flex; align-items: center; gap: 8px; padding: 8px 10px; margin-bottom: 6px; border: 1px solid var(--border); border-radius: 8px; cursor: grab; background: var(--panel); }
.seg-pill:hover { border-color: var(--border-2); }
.seg-pill.used { opacity: .55; }
.seg-pill .pi-bookmark { font-size: 12px; color: var(--accent); }
.sp-name { flex: 1 1 auto; min-width: 0; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* borderless inline editor that matches the name's box exactly (no padding/border ⇒ no height jump) */
.sp-edit { flex: 1 1 auto; min-width: 0; border: none; outline: none; padding: 0; margin: 0; background: transparent; font: inherit; font-size: 12.5px; line-height: inherit; color: var(--text); }
/* on hover, the count + used-tick are hidden (space kept ⇒ no layout shift) and the rename pen
   is overlaid on the far right (absolute ⇒ also no shift) */
.sp-rename { position: absolute; right: 9px; top: 50%; transform: translateY(-50%); border: none; background: none; color: var(--muted); cursor: pointer; padding: 0; line-height: 1; display: none; }
.sp-rename .pi { font-size: 12px; }
.seg-pill:hover .sp-rename { display: inline-flex; }
.seg-pill:hover .sp-size, .seg-pill:hover .sp-used { visibility: hidden; }
.sp-rename:hover { color: var(--text-strong); }
.seg-pill.editing { cursor: default; }
.sp-size { font-size: 11px; color: var(--muted); }
.sp-used { font-size: 11px; color: var(--accent); }

.builder { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; }
.b-head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
/* reads as a heading at rest; becomes a regular input box (border + bg) on hover/focus.
   transparent border + negative margin keep the resting position so nothing shifts. */
.b-name { flex: 1 1 auto; min-width: 0; box-sizing: border-box; border: 1px solid transparent; border-radius: 8px; background: transparent; font: inherit; font-size: 16px; font-weight: 650; color: var(--text-strong); padding: 6px 10px; margin-left: -10px; transition: border-color .12s, background .12s; }
.b-name:hover { border-color: var(--border); }
.b-name:focus { outline: none; border-color: var(--accent); background: var(--panel); }
.b-size { display: flex; align-items: baseline; gap: 5px; background: var(--panel-2); border-radius: 8px; padding: 5px 12px; }
.bs-num { font-size: 20px; font-weight: 650; color: var(--text-strong); } .bs-lbl { font-size: 12px; color: var(--muted); }

.b-rulebar { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.b-op { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.b-op button { border: none; background: none; font: inherit; font-size: 12px; padding: 5px 11px; cursor: pointer; color: var(--muted); }
.b-op button.on { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.b-resolve { font-size: 11.5px; color: var(--muted); display: inline-flex; align-items: center; gap: 5px; }

.b-rule { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-height: 68px; padding: 14px; border: 1.5px dashed var(--border); border-radius: 10px; }
.b-rule.drop { border-color: var(--accent); background: var(--accent-soft); }
.b-empty { font-size: 12.5px; color: var(--muted); }
.op-join { font-size: 11px; font-weight: 600; color: var(--muted); }
.mem { display: inline-flex; align-items: center; gap: 7px; padding: 6px 8px 6px 10px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 999px; font-size: 13px; }
.mem.neg { background: var(--danger-soft, rgba(239,68,68,.08)); border-color: rgba(239,68,68,.25); }
.mem-name { font-weight: 550; color: var(--text-strong); }
.mem-size { font-size: 11px; color: var(--muted); }
.mem-neg { display: inline-flex; align-items: center; border: none; background: none; cursor: pointer; padding: 0 1px; color: var(--muted); }
.mem-neg i { font-size: 12px; }
.mem-neg:hover { color: var(--text-strong); }
.mem-neg.on { color: var(--danger); }
.mem-neg.on:hover { color: var(--danger); }
.mem-x { border: none; background: none; cursor: pointer; color: var(--muted); font-size: 11px; padding: 0; }
.mem-x:hover { color: var(--text-strong); }

.b-actions { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
.b-saved { margin-left: auto; font-size: 12px; color: var(--accent); display: inline-flex; align-items: center; gap: 4px; }

.act-body { flex: 1 1 auto; overflow: auto; padding: 16px 18px; }
.actid-field { padding-bottom: 14px; }
.actid-label { display: block; font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; }
.actid-input { display: flex; align-items: center; gap: 2px; border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; }
.actid-input > span { color: var(--muted); font-size: 13px; }
.actid-input input { flex: 1; min-width: 0; border: none; background: none; font-family: var(--font-mono, ui-monospace, monospace); font-size: 12.5px; color: var(--text-strong); padding: 0; }
.actid-input input:focus { outline: none; }
.actid-input:focus-within { border-color: var(--accent); }
.actid-hint { margin: 6px 0 0; font-size: 11px; color: var(--muted); }
/* channel group label (On-site / Ad networks) */
.chan-head { font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin: 16px 0 0; }
.net-row { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-top: 1px solid var(--border); }
.net-row.first { border-top: none; }   /* the chan-head above is the separator */
.net-row .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; } .net-row .dot.off { background: var(--border-2); }
.net-main { flex: 1 1 auto; } .net-name { font-size: 13px; } .net-name.muted { color: var(--muted); } .net-sub { font-size: 11px; color: var(--muted); }
.sw { width: 30px; height: 18px; border-radius: 999px; background: var(--border-2); position: relative; flex: none; border: none; padding: 0; cursor: pointer; }
.sw i { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: left .14s, right .14s; }
.sw.on { background: var(--accent); } .sw.on i { left: auto; right: 2px; }
.sw:disabled { opacity: .5; cursor: default; }
.net-connect { flex: none; border: 1px solid var(--border); background: none; color: var(--accent); font: inherit; font-size: 12px; font-weight: 600; padding: 4px 12px; border-radius: 999px; cursor: pointer; transition: border-color .12s, background .12s; }
.net-connect:hover { border-color: var(--accent); background: var(--accent-soft); }
.act-hint { margin: 10px 0 0; font-size: 11.5px; color: var(--muted); }
</style>
