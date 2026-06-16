export const up = knex => knex.schema.createTable('whitebox_mail_inbox', t => {
  t.increments('id')
  t.uuid('passport_id').nullable().references('id').inTable('whitebox_passports')  // null if passport creation failed
  t.integer('session_id').nullable().references('id').inTable('whitebox_sessions') // null for inbound emails with no web session
  t.string('source', 16).notNullable()                                             // form | inbound
  t.string('from', 256).notNullable()                                              // sender email address
  t.string('to', 256).nullable()                                                   // recipient within the company domain
  t.string('subject', 512)
  t.text('body')
  t.timestamp('received_at').notNullable().defaultTo(knex.fn.now())
  t.index('passport_id')
  t.index('session_id')
})

export const down = knex => knex.schema.dropTable('whitebox_mail_inbox')
