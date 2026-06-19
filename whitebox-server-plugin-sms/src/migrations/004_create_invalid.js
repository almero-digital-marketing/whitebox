export const up = async knex => {
  await knex.schema.createTable('whitebox_sms_invalid', t => {
    t.increments('id').primary()
    t.text('phone').notNullable().unique()         // E.164
    t.text('reason').notNullable()                 // undeliverable | rejected | invalid_number
    t.text('source').nullable()                    // provider | api | manual
    t.text('error_message').nullable()
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now())
  })
}

export const down = async knex => {
  await knex.schema.dropTable('whitebox_sms_invalid')
}
