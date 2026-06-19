export const up = knex => knex.schema.createTable('whitebox_sms_outbox', t => {
  t.increments('id')
  t.uuid('passport_id').nullable().references('id').inTable('whitebox_passports')
  t.integer('session_id').nullable().references('id').inTable('whitebox_sessions')
  t.string('to', 32).notNullable()                                   // recipient, E.164
  t.string('from', 32).nullable()                                    // sender id / number
  t.text('body').nullable()                                          // literal body, or rendered from template at send
  t.jsonb('media').nullable()                                        // MMS media URLs
  t.string('template', 128).nullable()                              // optional mikser layout id
  t.jsonb('data').nullable()                                         // per-recipient template vars
  t.string('provider', 32).nullable()                               // which provider handled it (routing audit)
  t.string('provider_message_id', 64).nullable()                    // Twilio SID / Mobica idd, set after send
  t.integer('segments').nullable()                                  // computed segment count
  t.string('status', 16).notNullable().defaultTo('queued')          // queued | sent | delivered | undelivered | failed | cancelled
  t.integer('attempts').notNullable().defaultTo(0)
  t.string('failure_reason', 512).nullable()
  t.text('failure_log').nullable()
  t.string('idempotency_key', 256).nullable()
  t.uuid('batch_id').nullable()
  t.timestamp('queued_at').notNullable().defaultTo(knex.fn.now())
  t.timestamp('sent_at').nullable()
  t.timestamp('delivered_at').nullable()
  t.timestamp('failed_at').nullable()
  t.timestamp('cancelled_at').nullable()
  t.index('passport_id')
  t.index('session_id')
  t.index('provider_message_id')
  t.index('status')
  t.index('batch_id')
  t.unique('idempotency_key')
})

export const down = knex => knex.schema.dropTable('whitebox_sms_outbox')
