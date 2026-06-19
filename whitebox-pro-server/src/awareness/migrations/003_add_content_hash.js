export const up = async knex => {
  await knex.schema.alterTable('whitebox_awareness_exposures', t => {
    t.string('content_hash', 64)
    t.index('content_hash')
  })
  await knex.schema.alterTable('whitebox_awareness_chunks', t => {
    t.string('content_hash', 64)
    t.index('content_hash')
  })
}

export const down = async knex => {
  await knex.schema.alterTable('whitebox_awareness_chunks', t => {
    t.dropColumn('content_hash')
  })
  await knex.schema.alterTable('whitebox_awareness_exposures', t => {
    t.dropColumn('content_hash')
  })
}
