export const up = knex => knex.schema.createTable('whitebox_awareness_exposures', t => {
  t.bigIncrements('id')
  t.uuid('passport_id').notNullable()
    .references('id').inTable('whitebox_passports').onDelete('CASCADE')
  t.integer('session_id').references('id').inTable('whitebox_sessions')
  t.timestamp('ts', { useTz: true }).notNullable()
  t.string('channel', 16).notNullable()      // 'web' | 'mail' | 'voip'
  t.string('direction', 16).notNullable()    // 'exposure' | 'expression' | 'conversation'
  t.string('source', 32)                     // 'section' | 'video' | 'image' | 'email' | 'call'
  t.string('content_id', 256)
  t.text('content_url')
  t.text('text').notNullable()
  t.integer('dwell_ms')
  t.jsonb('meta')
  t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now())
  t.index(['passport_id', 'ts'])
  t.index(['channel', 'direction'])
  t.index('content_id')
})

export const down = knex => knex.schema.dropTable('whitebox_awareness_exposures')
