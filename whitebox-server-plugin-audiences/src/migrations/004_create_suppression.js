// Suppression = a hard do-not-target list. A suppressed passport is never
// evaluated/fired regardless of rules or consent. See docs/08-consent-privacy.md.

export const up = knex => knex.schema.createTable('whitebox_audience_suppression', t => {
  t.uuid('passport_id').primary()
  t.string('reason', 200)
  t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now())
})

export const down = knex => knex.schema.dropTable('whitebox_audience_suppression')
