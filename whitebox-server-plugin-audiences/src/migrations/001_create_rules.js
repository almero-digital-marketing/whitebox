// Rule = a declarative segment definition. The evaluator turns a rule into
// matches; delivery turns matches into fired events. See docs/03-rules.md.

export const up = knex => knex.schema.createTable('whitebox_audience_rules', t => {
  t.string('id', 64).primary()              // stable slug, e.g. 'enterprise_ready'
  t.string('name', 200).notNullable()
  t.boolean('enabled').notNullable().defaultTo(false)

  t.text('seed').notNullable()              // text seed for the semantic vector-narrow
  t.text('criteria').notNullable()          // natural-language rule the AI judges against
  t.float('threshold').notNullable().defaultTo(0.7)
  t.integer('ttl_days').notNullable().defaultTo(30)

  t.string('policy', 32).notNullable().defaultTo('non_sensitive')
  t.jsonb('requires').notNullable().defaultTo('{}')   // { semantic, metric, crm }
  t.jsonb('delivery').notNullable().defaultTo('{}')   // { meta:{event}, tiktok:{event}, google:{event} }

  t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now())
  t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now())
  t.string('updated_by', 200)
  t.index('enabled')
})

export const down = knex => knex.schema.dropTable('whitebox_audience_rules')
