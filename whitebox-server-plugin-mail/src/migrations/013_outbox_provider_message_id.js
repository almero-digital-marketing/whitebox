// The outbox used to store a Mailgun-specific `mailgun_id`. Mail providers are
// now pluggable (whitebox-mail-mailgun, whitebox-mail-postmark, …), so the
// column is renamed to the provider-neutral `provider_message_id`. The index
// follows the column automatically in Postgres.
export const up = knex => knex.schema.alterTable('whitebox_mail_outbox', t => {
  t.renameColumn('mailgun_id', 'provider_message_id')
})

export const down = knex => knex.schema.alterTable('whitebox_mail_outbox', t => {
  t.renameColumn('provider_message_id', 'mailgun_id')
})
