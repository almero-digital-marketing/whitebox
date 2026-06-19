export const up = knex => knex.schema.createTable('whitebox_engagement_content', t => {
  t.text('url').primary()
  t.string('kind', 16).notNullable()        // 'video' | 'image'
  t.text('text')                            // transcription or description
  t.jsonb('segments')                       // [{ start_s, end_s, audio, visual }] for video
  t.string('source_kind', 16).notNullable() // 'auto' | 'provided'
  t.jsonb('meta')
  t.timestamp('generated_at', { useTz: true }).defaultTo(knex.fn.now())
})

export const down = knex => knex.schema.dropTable('whitebox_engagement_content')
