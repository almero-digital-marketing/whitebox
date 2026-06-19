export const up = async knex => {
  await knex.schema.alterTable('whitebox_mail_outbox', t => {
    t.string('idempotency_key', 128).nullable()
    t.integer('attempts').notNullable().defaultTo(0)
    t.text('failure_log').nullable()
  })
  await knex.raw(`
    CREATE UNIQUE INDEX whitebox_mail_outbox_idempotency_key_unique
      ON whitebox_mail_outbox (idempotency_key)
      WHERE idempotency_key IS NOT NULL
  `)
}

export const down = async knex => {
  await knex.raw('DROP INDEX IF EXISTS whitebox_mail_outbox_idempotency_key_unique')
  await knex.schema.alterTable('whitebox_mail_outbox', t => {
    t.dropColumn('failure_log')
    t.dropColumn('attempts')
    t.dropColumn('idempotency_key')
  })
}
