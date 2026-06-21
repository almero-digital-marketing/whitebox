export const up = async knex => {
  await knex.schema.createTable('whitebox_sms_suppressions', t => {
    t.increments('id').primary()
    t.text('phone').notNullable().unique()         // E.164
    t.text('reason').notNullable()                 // unsubscribed | complained | manual
    t.text('source').nullable()                    // inbound | api | manual
    t.text('notes').nullable()
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now())
  })
}

export const down = async knex => {
  await knex.schema.dropTable('whitebox_sms_suppressions')
}
