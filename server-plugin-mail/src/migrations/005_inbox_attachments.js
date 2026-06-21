export const up = async knex => {
  await knex.schema.alterTable('whitebox_mail_inbox', t => {
    t.specificType('attachments', 'text[]').nullable()
  })
}

export const down = async knex => {
  await knex.schema.alterTable('whitebox_mail_inbox', t => {
    t.dropColumn('attachments')
  })
}
