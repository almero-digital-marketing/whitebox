export const up = async knex => {
  await knex.schema.createTable('whitebox_mail_suppressions', t => {
    t.increments('id').primary()
    t.text('email').notNullable().unique()
    t.text('reason').notNullable() // unsubscribed | bounced | complained | manual
    t.text('source').nullable()    // mailgun | manual | api
    t.text('notes').nullable()
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now())
  })
}

export const down = async knex => {
  await knex.schema.dropTable('whitebox_mail_suppressions')
}
