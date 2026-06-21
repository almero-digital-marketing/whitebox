// A rule is now a saved core *selector*, not a bespoke seed/criteria/requires
// triple — the engine (ctx.selector) does all the selection. Replace the legacy
// selection columns with one `selector` jsonb, and drop the fact-keys discovery
// cache (the deleted crm feature owned it; fact keys now come from core facts).
export const up = async knex => {
  await knex.schema.alterTable('whitebox_audience_rules', t => {
    t.dropColumn('seed')
    t.dropColumn('criteria')
    t.dropColumn('threshold')
    t.dropColumn('requires')
    t.jsonb('selector').notNullable().defaultTo('{}')   // the about / filter / judge predicate
  })
  await knex.schema.dropTableIfExists('whitebox_audience_fact_keys')
}

// Best-effort rollback (the legacy selection model is gone; recreate the columns
// empty if you truly need to revert).
export const down = async knex => {
  await knex.schema.alterTable('whitebox_audience_rules', t => {
    t.dropColumn('selector')
    t.text('seed')
    t.text('criteria')
    t.float('threshold').defaultTo(0.7)
    t.jsonb('requires').defaultTo('{}')
  })
}
