// Composition tables — the analytics plugin's own state (reports + widgets).
// A report is a named board; a widget is one thing on it that references a
// query. For v1 the query is stored INLINE on the widget (the core saved-query
// store — docs/saved-queries.md — isn't built yet); when it lands, a widget will
// instead carry a query_id and these inline defs become drafts. See
// docs/analytics-concept.md §2.

export const up = async (knex) => {
  await knex.schema.createTable('whitebox_reports', (t) => {
    t.uuid('id').primary()
    t.text('name').notNullable()
    t.jsonb('layout')                                   // grid arrangement (positions/order)
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })

  await knex.schema.createTable('whitebox_widgets', (t) => {
    t.uuid('id').primary()
    t.uuid('report_id').notNullable().references('id').inTable('whitebox_reports').onDelete('CASCADE')
    t.text('title')
    t.string('kind', 24).notNullable()                  // stat|timeseries|breakdown|funnel|table|answer
    t.jsonb('query').notNullable()                      // { selector?, funnel?, named?, projection?, scope?, passport?, group?, question?, asOf? }
    t.jsonb('presentation')                             // viz options (chart type, color, …)
    t.jsonb('position')                                 // { x, y, w, h } on the grid
    t.string('provenance', 16).notNullable().defaultTo('human')   // ai | human (A3)
    t.integer('sort').notNullable().defaultTo(0)
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    t.index(['report_id', 'sort'])
  })
}

export const down = async (knex) => {
  await knex.schema.dropTableIfExists('whitebox_widgets')
  await knex.schema.dropTableIfExists('whitebox_reports')
}
