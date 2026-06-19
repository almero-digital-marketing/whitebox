export const up = knex => knex.schema.createTable('whitebox_sms_inbox', t => {
  t.increments('id')
  t.uuid('passport_id').nullable().references('id').inTable('whitebox_passports')
  t.integer('session_id').nullable().references('id').inTable('whitebox_sessions')
  t.string('from', 32).notNullable()                                 // the customer's number, E.164
  t.string('to', 32).nullable()                                      // our number / sender id
  t.text('body').nullable()
  t.jsonb('media').nullable()
  t.string('provider', 32).nullable()
  t.string('provider_message_id', 64).nullable()
  t.string('keyword', 16).nullable()                                 // STOP / START / etc. if matched
  t.timestamp('created_at').notNullable().defaultTo(knex.fn.now())
  t.index('passport_id')
  t.index('from')
  t.index('provider_message_id')
})

export const down = knex => knex.schema.dropTable('whitebox_sms_inbox')
