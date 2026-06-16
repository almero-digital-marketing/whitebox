export const up = async knex => {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS vector')
  await knex.schema.createTable('whitebox_awareness_chunks', t => {
    t.bigIncrements('id')
    t.bigInteger('exposure_id').notNullable()
      .references('id').inTable('whitebox_awareness_exposures').onDelete('CASCADE')
    t.uuid('passport_id').notNullable()
    t.text('chunk_text').notNullable()
    t.specificType('embedding', 'vector(1536)').notNullable()
    t.timestamp('ts', { useTz: true }).notNullable()
    t.index('passport_id')
  })
  await knex.raw('CREATE INDEX ON whitebox_awareness_chunks USING hnsw (embedding vector_cosine_ops)')
}

export const down = knex => knex.schema.dropTable('whitebox_awareness_chunks')
