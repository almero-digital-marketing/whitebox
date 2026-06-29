// Campaigns data store. Thin orchestration over the campaigns HTTP client. `buildReport` reuses
// the Analytics compose pipeline (no new compose logic) to turn a campaign's prompt into a report.
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { campaignsClient as client } from '../campaigns'
import { api as analyticsApi } from '../../analytics/api'

export const useCampaignsStore = defineStore('campaigns', () => {
  const campaigns = ref<any[]>([])   // light list rows (no audiences); getCampaign() returns the full one
  const error = ref('')

  async function loadCampaigns() {
    try { campaigns.value = await client.list() } catch (e: any) { error.value = e.message }
  }
  const getCampaign = (id: string) => client.get(id)

  function upsertLocal(row: any) {
    if (!row?.id) return
    const i = campaigns.value.findIndex(c => c.id === row.id)
    if (i >= 0) campaigns.value = campaigns.value.map(c => (c.id === row.id ? { ...c, ...row } : c))
    else campaigns.value = [row, ...campaigns.value]
  }

  async function createCampaign(body: { name: string; channel: 'email' | 'sms'; message?: any }) {
    const row = await client.create(body); upsertLocal(row); return row
  }
  async function patchCampaign(id: string, body: any) { const row = await client.patch(id, body); upsertLocal(row); return row }
  async function removeCampaign(id: string) { await client.remove(id); campaigns.value = campaigns.value.filter(c => c.id !== id) }
  async function attachAudience(id: string, audienceId: string) { const row = await client.attachAudience(id, audienceId); upsertLocal(row); return row }
  async function detachAudience(id: string, audienceId: string) { const row = await client.detachAudience(id, audienceId); upsertLocal(row); return row }
  const previewDelivery = (id: string) => client.previewDelivery(id)
  async function scheduleCampaign(id: string, counts?: any) { const row = await client.schedule(id, counts); upsertLocal(row); return row }
  async function unlockCampaign(id: string) { const row = await client.unlock(id); upsertLocal(row); return row }

  // Build an Analytics performance report from the campaign's prompt → returns the new report id.
  async function buildReport(campaign: any) {
    const report = await analyticsApi.createReport(`${campaign.name} — performance`)
    await analyticsApi.compose(campaign.analytics_prompt || '', report.id)
    upsertLocal(await client.setReport(campaign.id, report.id))
    return report.id
  }

  return {
    campaigns, error,
    loadCampaigns, getCampaign, createCampaign, patchCampaign, removeCampaign,
    attachAudience, detachAudience, previewDelivery, scheduleCampaign, unlockCampaign, buildReport,
  }
})
