export const up = knex => knex.schema.createTable('whitebox_mail_outbox', t => {
  t.increments('id')
  t.uuid('passport_id').nullable().references('id').inTable('whitebox_passports')
  t.integer('session_id').nullable().references('id').inTable('whitebox_sessions')
  t.string('to', 256).notNullable()                                                // recipient email address
  t.string('subject', 512).notNullable()
  t.text('html')
  t.text('text')
  t.string('mailgun_id', 256).nullable()                                           // Mailgun message ID, set after send
  t.string('status', 16).notNullable().defaultTo('queued')                        // queued | sent | delivered | opened | engaged | bounced | complained
  t.timestamp('queued_at').notNullable().defaultTo(knex.fn.now())
  t.timestamp('sent_at').nullable()
  t.timestamp('delivered_at').nullable()
  t.timestamp('opened_at').nullable()
  t.timestamp('engaged_at').nullable()                                             // clicked a link
  t.timestamp('failed_at').nullable()
  t.string('failure_reason', 512).nullable()
  t.index('passport_id')
  t.index('session_id')
  t.index('mailgun_id')
  t.index('status')
})

export const down = knex => knex.schema.dropTable('whitebox_mail_outbox')
