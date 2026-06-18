// A cache of CRM fact keys the plugin has observed (via context.collect), so
// rule-authoring and `requires` validation can answer "what facts do we have?"
// without coupling to any specific CRM. See docs/07-crm-integration.md.

export const up = knex => knex.schema.createTable('whitebox_audience_fact_keys', t => {
  t.string('key', 128).primary()            // e.g. 'plan_tier', 'seat_count', 'mrr'
  t.string('type', 16)                       // inferred: 'number'|'string'|'bool'|'date'
  t.jsonb('sample')                          // a recent sample value (non-PII)
  t.integer('seen_count').notNullable().defaultTo(0)
  t.timestamp('last_seen', { useTz: true }).defaultTo(knex.fn.now())
})

export const down = knex => knex.schema.dropTable('whitebox_audience_fact_keys')
