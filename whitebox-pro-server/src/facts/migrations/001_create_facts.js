// Structured memory — the append-only, typed, value-queryable fact timeline.
// The structured twin of awareness (semantic). One row = one observation of one
// attribute of one passport at one time; a value change is a NEW row, never an
// overwrite. See whitebox-pro-server/docs/temporal-facts.md.
export const up = knex => knex.schema.createTable('whitebox_facts', t => {
  t.bigIncrements('id')
  t.uuid('passport_id').notNullable()
    .references('id').inTable('whitebox_passports').onDelete('CASCADE')
  t.string('key', 128).notNullable()            // 'plan_tier' | 'mrr' | 'subscription_status' | …
  t.jsonb('value').notNullable()                // typed: "pro" | 240 | true | "2026-07-01"
  t.string('type', 16).notNullable()            // 'string' | 'number' | 'bool' | 'date'
  t.string('source', 64).notNullable()          // where it came from: 'stripe' | 'hubspot' | 'app' | …
  t.string('entity', 256)                        // optional link to an external entity, e.g. 'subscription:sub_123'
  t.timestamp('observed_at', { useTz: true }).notNullable()   // VALID time: when this value became true
  t.timestamp('recorded_at', { useTz: true }).defaultTo(knex.fn.now())  // when we learned it (audit)
  t.index(['passport_id', 'key', 'observed_at'])  // current / as-of per passport
  t.index(['key', 'observed_at'])                 // population scans
})

export const down = knex => knex.schema.dropTable('whitebox_facts')
