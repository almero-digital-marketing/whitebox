// Campaigns — a planned email/SMS send to a set of audiences. The campaign DETAILS (name,
// subject, message, date) are owned by Mikser, which upserts from outside keyed by `external_id`;
// the UI owns the AUDIENCE binding (a many-to-many — recipients are the de-duped union) and the
// send. Executing a campaign LOCKS it (status='sent') and stamps real `stats`. A locked campaign
// can spawn an Analytics performance report (report_id) from `analytics_prompt`.
// See ../../docs and the plan. v1 send is dry-run (no provider).

export async function up(knex) {
  await knex.schema.createTable('whitebox_campaigns', t => {
    t.uuid('id').primary()
    t.text('external_id').unique()                          // Mikser's stable ref — the upsert key
    t.text('source')                                        // 'ui' | 'mikser'
    t.text('name').notNullable()
    t.text('channel').notNullable()                         // 'email' | 'sms'
    t.text('subject')                                       // email subject (Mikser-owned)
    t.timestamp('scheduled_at', { useTz: true })
    t.text('status').notNullable().defaultTo('draft')       // draft|scheduled|sending|sent|failed
    t.jsonb('message')                                      // { html?, text?, published_at? }
    t.jsonb('stats')                                        // real executed counts (once sent)
    t.text('analytics_prompt')                              // user-extended report prompt (null ⇒ default)
    t.uuid('report_id')                                     // linked Analytics report (once built)
    t.timestamp('sent_at', { useTz: true })
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now())
    t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now())
    t.index('created_at')
  })

  // many-to-many: a campaign targets several audiences (recipients = their de-duped union)
  await knex.schema.createTable('whitebox_campaign_audiences', t => {
    t.uuid('campaign_id').notNullable()
    t.uuid('audience_id').notNullable()
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now())
    t.primary(['campaign_id', 'audience_id'])
    t.index('audience_id')
  })

  // one row per send run (audit). batch_id links to a real mail/sms bulk send when wired (phase 2).
  await knex.schema.createTable('whitebox_campaign_sends', t => {
    t.uuid('id').primary()
    t.uuid('campaign_id').notNullable()
    t.text('channel')
    t.integer('resolved')
    t.integer('deliverable')
    t.integer('suppressed')
    t.integer('no_consent')
    t.boolean('dry_run').notNullable().defaultTo(true)
    t.text('batch_id')
    t.text('status')
    t.timestamp('sent_at', { useTz: true }).defaultTo(knex.fn.now())
    t.index('campaign_id')
  })
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('whitebox_campaign_sends')
  await knex.schema.dropTableIfExists('whitebox_campaign_audiences')
  await knex.schema.dropTableIfExists('whitebox_campaigns')
}
