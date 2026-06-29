// Data access. Thin knex wrappers — no business logic. init() + free functions.

let db

const CAMPAIGNS = 'whitebox_campaigns'
const CAMPAIGN_AUDIENCES = 'whitebox_campaign_audiences'
const SENDS = 'whitebox_campaign_sends'

export function init({ db: knex }) { db = knex }

// --- campaigns ---
export const listCampaigns = () => db(CAMPAIGNS).orderBy('created_at', 'desc')
export const getCampaign = id => db(CAMPAIGNS).where({ id }).first()
export const getCampaignByExternalId = external_id => db(CAMPAIGNS).where({ external_id }).first()
export async function insertCampaign(c) {
  const [row] = await db(CAMPAIGNS).insert(c).returning('*')
  return row
}
export async function updateCampaign(id, fields) {
  const [row] = await db(CAMPAIGNS).where({ id }).update({ ...fields, updated_at: db.fn.now() }).returning('*')
  return row
}
export const deleteCampaign = id => db(CAMPAIGNS).where({ id }).del()

// --- campaign ⇄ audience (many-to-many) ---
export const audienceIds = campaign_id =>
  db(CAMPAIGN_AUDIENCES).where({ campaign_id }).orderBy('created_at').pluck('audience_id')
export const attachAudience = (campaign_id, audience_id) =>
  db(CAMPAIGN_AUDIENCES).insert({ campaign_id, audience_id }).onConflict(['campaign_id', 'audience_id']).ignore()
export const detachAudience = (campaign_id, audience_id) =>
  db(CAMPAIGN_AUDIENCES).where({ campaign_id, audience_id }).del()
export const clearAudiences = campaign_id => db(CAMPAIGN_AUDIENCES).where({ campaign_id }).del()

// --- send audit ---
export async function insertSend(s) {
  const [row] = await db(SENDS).insert(s).returning('*')
  return row
}
