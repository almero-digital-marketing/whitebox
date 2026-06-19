// Send-level shortener config (e.g. { utm: { source, medium, campaign } }) used
// by the link-personalization pass at send time. Stored per row so a queued/
// batched send carries it to the worker. Nullable — most sends don't set it.
export const up = knex => knex.schema.alterTable('whitebox_mail_outbox', t => {
  t.jsonb('shorten').nullable()
})

export const down = knex => knex.schema.alterTable('whitebox_mail_outbox', t => {
  t.dropColumn('shorten')
})
