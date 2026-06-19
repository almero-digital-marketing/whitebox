export const up = async knex => {
  await knex.schema.alterTable('whitebox_mail_outbox', t => {
    t.string('template').nullable()
  })
}

export const down = async knex => {
  await knex.schema.alterTable('whitebox_mail_outbox', t => {
    t.dropColumn('template')
  })
}
