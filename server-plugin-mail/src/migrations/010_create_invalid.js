export const up = async knex => {
  await knex.schema.createTable('whitebox_mail_invalid', t => {
    t.increments('id').primary()
    t.text('email').notNullable().unique()
    t.text('reason').notNullable() // bounced | rejected | invalid_syntax
    t.text('source').nullable()    // mailgun | api | manual
    t.text('error_message').nullable()
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now())
  })
}

export const down = async knex => {
  await knex.schema.dropTable('whitebox_mail_invalid')
}
