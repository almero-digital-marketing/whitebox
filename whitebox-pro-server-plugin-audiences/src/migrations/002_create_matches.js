// Match = the record that a passport qualified for a rule, with the AI's reason.
// In Mode A this is NOT a membership roster you push — it's a qualification +
// audit record, and the source of truth for keep-warm re-firing and `explain`.
// See docs/02-concepts.md.

export const up = knex => knex.schema.createTable('whitebox_audience_matches', t => {
  t.bigIncrements('id')
  t.string('rule_id', 64).notNullable().references('id').inTable('whitebox_audience_rules').onDelete('CASCADE')
  t.uuid('passport_id').notNullable()

  t.boolean('qualified').notNullable().defaultTo(false)
  t.float('score')
  t.text('reason')                          // the AI justification (audit / GDPR "why")
  t.jsonb('evidence')                       // recalled chunks + metric/fact features used

  t.timestamp('first_matched_at', { useTz: true })
  t.timestamp('last_evaluated_at', { useTz: true }).defaultTo(knex.fn.now())
  t.timestamp('last_fired_at', { useTz: true })       // drives keep-warm cadence
  t.jsonb('fired').notNullable().defaultTo('{}')      // { meta:ts, tiktok:ts, google:ts }

  t.unique(['rule_id', 'passport_id'])
  t.index(['rule_id', 'qualified'])
  t.index('passport_id')
  t.index('last_fired_at')
})

export const down = knex => knex.schema.dropTable('whitebox_audience_matches')
