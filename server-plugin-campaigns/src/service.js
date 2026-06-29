// Service layer — the single implementation REST (and, later, MCP) calls. No transport here.
//
// Cross-plugin: campaigns reuse the AUDIENCES plugin's service (injected as deps.audiences) for
// audience resolution + consent gating — we never re-implement set algebra or consent. The UI
// owns the audience binding (many-to-many) + scheduling; Mikser upserts the content (by external_id).
// Executing LOCKS the campaign and stamps real stats. Delivery is dry-run by default (the
// `dryRun` config switch) and goes live through the host-wired `deliver` hook (→ mail/sms plugins).

import { randomUUID } from 'node:crypto'
import { validateInput, validateUpsert, fromRow, isLocked } from './campaigns.js'

let store, audiences, deliver, dryRun, logger

export function init(deps) {
  ({ store, audiences, deliver, dryRun, logger } = deps)
}

// --- read ---
export const listCampaigns = async () => (await store.listCampaigns()).map(fromRow)

// Full campaign: + its attached audiences (id, name, size) + a resolved analytics_prompt.
export async function getCampaign(id) {
  const row = await store.getCampaign(id)
  if (!row) return null
  const c = fromRow(row)
  c.audiences = await attachedAudiences(id)
  c.analytics_prompt = c.analytics_prompt || defaultPrompt(c, c.audiences.map(a => a.name))
  return c
}

// the attached audiences with a best-effort live size (resolved via the audiences plugin)
async function attachedAudiences(campaignId) {
  const ids = await store.audienceIds(campaignId)
  return Promise.all(ids.map(async (audience_id) => {
    let name = audience_id, size = null
    try { const a = await audiences.getAudience(audience_id); if (a) name = a.name } catch { /* deleted */ }
    try { size = (await audiences.resolveAudience(audience_id)).count } catch { /* best-effort */ }
    return { id: audience_id, name, size }
  }))
}

// --- write (UI) ---
export async function saveCampaign(input) {
  const a = validateInput(input)
  if (!a.name || !a.channel) { const e = new Error('name and channel are required'); e.status = 400; throw e }
  const row = await store.insertCampaign({
    id: randomUUID(), source: 'ui', name: a.name, channel: a.channel,
    subject: a.subject ?? null, scheduled_at: a.scheduled_at ?? null,
    message: a.message ? JSON.stringify(a.message) : null,
    analytics_prompt: a.analytics_prompt ?? null,
  })
  return getCampaign(row.id)
}

export async function patchCampaign(id, input) {
  await loadEditable(id)
  const a = validateInput({ ...input, id })
  const fields = {}
  for (const k of ['name', 'channel', 'subject', 'scheduled_at', 'analytics_prompt', 'report_id']) {
    if (a[k] !== undefined) fields[k] = a[k]
  }
  if (a.message !== undefined) fields.message = a.message ? JSON.stringify(a.message) : null
  if (a.objective !== undefined) fields.objective = a.objective ? JSON.stringify(a.objective) : null
  // Light response (no audience cohort resolution) — a field edit doesn't change the audience
  // set, so don't pay to re-resolve every attached audience's size on every keystroke/toggle.
  return fromRow(await store.updateCampaign(id, fields))
}

// Mikser create-or-update (idempotent on external_id). Owns all content; never the audiences.
export async function upsertCampaign(input) {
  const a = validateUpsert(input)
  const existing = await store.getCampaignByExternalId(a.external_id)
  const fields = {
    name: a.name, channel: a.channel, subject: a.subject ?? null,
    scheduled_at: a.scheduled_at ?? null, message: a.message ? JSON.stringify(a.message) : null,
  }
  if (existing) {
    if (isLocked(fromRow(existing))) { const e = new Error('campaign is locked (already sent)'); e.status = 409; throw e }
    await store.updateCampaign(existing.id, { ...fields, source: 'mikser' })
    return getCampaign(existing.id)
  }
  const row = await store.insertCampaign({ id: randomUUID(), source: 'mikser', external_id: a.external_id, ...fields })
  return getCampaign(row.id)
}

export async function deleteCampaign(id) { return store.deleteCampaign(id) }

// --- audiences (many-to-many; UI only) ---
export async function attachAudience(id, audienceId) {
  await loadEditable(id)
  if (!audienceId) { const e = new Error('audience_id required'); e.status = 400; throw e }
  await store.attachAudience(id, audienceId)
  return getCampaign(id)
}
export async function detachAudience(id, audienceId) {
  await loadEditable(id)
  await store.detachAudience(id, audienceId)
  return getCampaign(id)
}

// --- delivery preview: consent-gated UNION of the attached audiences (counts only) ---
export async function previewDelivery(id) {
  await getOr404(id)
  const ids = await unionPassports(id)
  return audiences.previewCohort(ids)
}

async function unionPassports(campaignId) {
  const audIds = await store.audienceIds(campaignId)
  const seen = new Set()
  for (const audId of audIds) {
    try { for (const pid of (await audiences.resolveAudience(audId)).ids) seen.add(pid) }
    catch (err) { logger?.warn?.({ err, audId }, 'campaigns: resolveAudience failed') }
  }
  return [...seen]
}

// --- schedule: commit the campaign for delivery at its scheduled_at and LOCK it for edits.
// If the send time has already passed (or is now), delivery fires immediately and the campaign
// goes straight to 'sent' (stats + sent_at) — a report only makes sense once it's been delivered.
// A future time stays 'scheduled' (locked, awaiting the send worker; no report yet). Either way
// you don't "send" from the UI — you schedule, and a past time is just due.
export async function schedule(id, { counts } = {}) {
  const c = fromRow(await getOr404(id))
  if (isLocked(c)) { const e = new Error('campaign already scheduled'); e.status = 409; throw e }
  const ready = c.channel === 'sms' ? !!c.message?.text : !!c.message?.html
  const audIds = await store.audienceIds(id)
  if (!audIds.length) { const e = new Error('attach at least one audience first'); e.status = 400; throw e }
  if (!ready) { const e = new Error('the message is not ready yet'); e.status = 400; throw e }
  if (!c.scheduled_at) { const e = new Error('set a send date and time first'); e.status = 400; throw e }

  // Reuse the reach the UI already previewed (server-computed moments ago) — only resolve the
  // cohort here if it wasn't supplied. And return LIGHT (no audience re-resolution). Together
  // these drop the lock from ~two full cohort resolves to ~zero.
  let n = counts
  if (!n || n.deliverable == null) n = await audiences.previewCohort(await unionPassports(id))

  const due = new Date(c.scheduled_at).getTime() <= Date.now()    // past/now ⇒ deliver immediately
  if (!due) {
    // committed for a future time — project the reach; dry_run reflects the configured mode.
    const stats = { resolved: n.resolved, suppressed: n.suppressed, no_consent: n.no_consent, reach: n.deliverable, dry_run: dryRun }
    return fromRow(await store.updateCampaign(id, { status: 'scheduled', stats: JSON.stringify(stats) }))
  }
  const stats = await runDelivery(c, n)   // dry-run records; live hands off to the deliver hook
  return fromRow(await store.updateCampaign(id, { status: 'sent', sent_at: new Date().toISOString(), stats: JSON.stringify(stats) }))
}

// Deliver a DUE campaign and return the stats to stamp. `dryRun` (config; default ON) is the
// safety switch: it records the projected reach as "sent" WITHOUT sending. Live mode resolves the
// consent-gated deliverable cohort and hands it to the host `deliver` hook (→ mail/sms plugins).
async function runDelivery(c, n) {
  const base = { resolved: n.resolved, suppressed: n.suppressed, no_consent: n.no_consent }
  if (dryRun) return { ...base, sent: n.deliverable, dry_run: true }
  if (typeof deliver !== 'function') {
    const e = new Error('live delivery is not configured — set campaigns.dryRun=true or wire the deliver hook')
    e.status = 500; throw e
  }
  const passportIds = await audiences.deliverableCohort(await unionPassports(c.id))
  const res = await deliver({ campaign: c, channel: c.channel, subject: c.subject, message: c.message, passportIds })
  return { ...base, sent: passportIds.length, batch_id: res?.batch_id ?? res?.id ?? null, dry_run: false }
}

// link the Analytics report built from this campaign (allowed post-send)
export async function setReport(id, reportId) {
  await getOr404(id)
  return fromRow(await store.updateCampaign(id, { report_id: reportId }))   // light — no audience re-resolve
}

// Unlock a SCHEDULED campaign back to an editable draft — pull it back before it's delivered.
// A delivered (sent) campaign is final and can't be unlocked (delete it instead). Clears the
// send stamp + stats so it reads as a draft again; the linked report (if any) is kept.
export async function unlockCampaign(id) {
  const c = fromRow(await getOr404(id))
  if (c.status === 'sent') { const e = new Error('a delivered campaign is final and can’t be unlocked'); e.status = 409; throw e }
  return fromRow(await store.updateCampaign(id, { status: 'draft', sent_at: null, stats: null }))   // light
}

// --- helpers ---
async function getOr404(id) {
  const row = await store.getCampaign(id)
  if (!row) { const e = new Error('campaign not found'); e.status = 404; throw e }
  return row
}
async function loadEditable(id) {
  const row = await getOr404(id)
  if (isLocked(fromRow(row))) { const e = new Error('campaign is locked (already sent)'); e.status = 409; throw e }
  return row
}

// The default, user-extendable report prompt — built from the campaign's OBJECTIVES (goals +
// notes) so the AI report measures what the campaign was actually for, plus channel/audience/size.
function defaultPrompt(c, audienceNames = []) {
  const when = c.sent_at || c.scheduled_at
  const date = when ? new Date(when).toISOString().slice(0, 10) : ''
  const who = audienceNames.length ? ` to ${audienceNames.join(', ')}` : ''
  const n = c.stats?.sent != null ? `${c.stats.sent} people` : 'its recipients'
  const goals = (c.objective?.goals || [])
  const objBits = [goals.join(', '), c.objective?.notes].filter(Boolean).join(' — ')
  const objLine = objBits ? ` Its objectives were: ${objBits}.` : ''
  const measure = goals.length
    ? `Build charts that measure performance against each objective (${goals.join(', ')})`
    : 'Build charts measuring delivery and open/click rates, the bookings and revenue it drove'
  return `Report on the "${c.name}" ${c.channel} campaign${date ? ` sent ${date}` : ''}${who} (${n}).${objLine} ${measure}, and show which audiences responded best.`
}
