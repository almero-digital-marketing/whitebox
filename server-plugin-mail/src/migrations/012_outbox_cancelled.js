export const up = async knex => {
  await knex.schema.alterTable('whitebox_mail_outbox', t => {
    t.timestamp('cancelled_at', { useTz: true }).nullable()
  })
}

export const down = async knex => {
  await knex.schema.alterTable('whitebox_mail_outbox', t => {
    t.dropColumn('cancelled_at')
  })
}
