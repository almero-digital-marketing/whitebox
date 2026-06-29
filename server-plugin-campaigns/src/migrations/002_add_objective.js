// Campaign objectives — what the campaign is trying to achieve (goals + free-text notes).
// Configured in the UI setup; drives the AI-built performance report (the default report prompt
// is generated from these objectives).

export async function up(knex) {
  await knex.schema.alterTable('whitebox_campaigns', t => t.jsonb('objective'))  // { goals: string[], notes?: string }
}

export async function down(knex) {
  await knex.schema.alterTable('whitebox_campaigns', t => t.dropColumn('objective'))
}
