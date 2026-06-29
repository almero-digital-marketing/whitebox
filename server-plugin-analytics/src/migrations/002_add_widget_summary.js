// Cache the plain-language summary of a widget's query on the widget itself, so
// switching Query → Agent reuses it instead of re-calling the AI every time. It's
// nulled whenever the query changes (see store.updateWidget) and regenerated lazily.

export const up = async (knex) => {
  await knex.schema.alterTable('whitebox_widgets', (t) => { t.text('summary') })
}

export const down = async (knex) => {
  await knex.schema.alterTable('whitebox_widgets', (t) => { t.dropColumn('summary') })
}
