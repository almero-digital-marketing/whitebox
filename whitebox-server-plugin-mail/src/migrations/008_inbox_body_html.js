export const up = async knex => {
  await knex.schema.alterTable('whitebox_mail_inbox', t => {
    t.text('body_html').nullable()
  })
}

export const down = async knex => {
  await knex.schema.alterTable('whitebox_mail_inbox', t => {
    t.dropColumn('body_html')
  })
}
