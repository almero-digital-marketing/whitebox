// Segments — a chart-derived dynamic sub-query, the atom of the audience layer.
// A segment is a saved selector source (a `select` selector OR a `funnel` + slot)
// with NO delivery of its own — reusable, named, and dedup'd by `predicate_key`.
// Audiences (AND/OR/NOT compositions of segments) build on these.
// See docs/11-segments-and-audiences.md.

export const up = knex => knex.schema.createTable('whitebox_audience_segments', t => {
  t.uuid('id').primary()
  t.text('name')                                          // AI-generated human label
  t.jsonb('source').notNullable()                         // { select } | { funnel, slot, status }
  t.string('predicate_key', 64).notNullable().unique()    // sha256 of the stable source → dedup identity
  t.jsonb('origin')                                       // provenance: { widget_id?, report_id?, selection }
  t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now())
  t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now())
})

export const down = knex => knex.schema.dropTable('whitebox_audience_segments')
