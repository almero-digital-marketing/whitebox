// Index the exposure `meta` jsonb so the selector's attribute filters/groups
// (docs/event-attributes.md §4.4) don't full-scan. The `event` action key is the
// hot one — an expression index serves equality + grouping on it. A GIN index
// (jsonb_path_ops) backs ad-hoc containment filters on other keys.
export const up = async knex => {
  await knex.raw(`CREATE INDEX IF NOT EXISTS whitebox_awareness_exposures_meta_event_idx
                  ON whitebox_awareness_exposures ((meta ->> 'event'))`)
  await knex.raw(`CREATE INDEX IF NOT EXISTS whitebox_awareness_exposures_meta_gin_idx
                  ON whitebox_awareness_exposures USING gin (meta jsonb_path_ops)`)
}

export const down = async knex => {
  await knex.raw('DROP INDEX IF EXISTS whitebox_awareness_exposures_meta_event_idx')
  await knex.raw('DROP INDEX IF EXISTS whitebox_awareness_exposures_meta_gin_idx')
}
