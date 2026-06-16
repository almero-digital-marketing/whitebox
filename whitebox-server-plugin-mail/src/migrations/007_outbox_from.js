export const up = async knex => {
  await knex.schema.alterTable('whitebox_mail_outbox', t => {
    t.string('from').nullable()
  })
}

export const down = async knex => {
  await knex.schema.alterTable('whitebox_mail_outbox', t => {
    t.dropColumn('from')
  })
}
