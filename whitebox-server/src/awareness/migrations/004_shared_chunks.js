// Switch chunks from per-exposure to per-content_hash.
// Chunks are deduped by (content_hash, chunk_index) — one set per unique content,
// shared across all exposures that reference it via content_hash.
//
// No production data exists at this point, so we drop & recreate.

export const up = async knex => {
  await knex.schema.dropTableIfExists('whitebox_awareness_chunks')

  await knex.schema.createTable('whitebox_awareness_chunks', t => {
    t.bigIncrements('id')
    t.string('content_hash', 64).notNullable()
    t.integer('chunk_index').notNullable()
    t.text('chunk_text').notNullable()
    t.specificType('embedding', 'vector(1536)').notNullable()
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now())
    t.unique(['content_hash', 'chunk_index'])
    t.index('content_hash')
  })

  await knex.raw('CREATE INDEX ON whitebox_awareness_chunks USING hnsw (embedding vector_cosine_ops)')
}

export const down = async knex => {
  await knex.schema.dropTable('whitebox_awareness_chunks')

  // Re-create the pre-shared schema (matching migration 002 + 003)
  await knex.schema.createTable('whitebox_awareness_chunks', t => {
    t.bigIncrements('id')
    t.bigInteger('exposure_id').notNullable()
      .references('id').inTable('whitebox_awareness_exposures').onDelete('CASCADE')
    t.uuid('passport_id').notNullable()
    t.text('chunk_text').notNullable()
    t.specificType('embedding', 'vector(1536)').notNullable()
    t.timestamp('ts', { useTz: true }).notNullable()
    t.string('content_hash', 64)
    t.index('passport_id')
    t.index('content_hash')
  })
  await knex.raw('CREATE INDEX ON whitebox_awareness_chunks USING hnsw (embedding vector_cosine_ops)')
}
