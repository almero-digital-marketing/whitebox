// An audience source can now be a funnel cohort, not just a selector (§14): a
// step's completers ("step:2") or a gap ("gap:2→3", optionally pending/dropped).
// A rule carries EITHER `selector` OR (`funnel` + `slot`), so `selector` becomes
// nullable and the funnel columns are added.
export const up = knex => knex.schema.alterTable('whitebox_audience_rules', t => {
  t.setNullable('selector')
  t.jsonb('funnel').nullable()          // the funnel spec { within?, steps[] }
  t.string('slot', 32).nullable()       // "step:N" | "gap:N→M"
  t.string('status', 16).nullable()     // gap slots: "pending" | "dropped"
})

export const down = knex => knex.schema.alterTable('whitebox_audience_rules', t => {
  t.dropColumn('funnel')
  t.dropColumn('slot')
  t.dropColumn('status')
  t.setNotNullable('selector')
})
