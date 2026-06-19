export const up = async knex => {
  await knex.schema.alterTable('whitebox_mail_outbox', t => {
    t.uuid('batch_id').nullable().index()
    t.jsonb('data').nullable()
  })
}

export const down = async knex => {
  await knex.schema.alterTable('whitebox_mail_outbox', t => {
    t.dropColumn('data')
    t.dropColumn('batch_id')
  })
}
