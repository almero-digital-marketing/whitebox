export const up = knex => knex.schema.createTable('whitebox_voip_calls', t => {
  t.increments('id')
  t.string('vault_id', 64).notNullable().unique()  // SHA-256 derived from PBX linkedId, stable across all events of the same call
  t.uuid('passport_id').references('id').inTable('whitebox_passports').nullable()  // passport of the caller, null if identification failed
  t.integer('session_id').references('id').inTable('whitebox_sessions')  // web session active on the line at ring time, null for direct calls
  t.string('caller', 32)        // E.164 number of the incoming caller
  t.string('line', 32)          // E.164 number of the line that was called
  t.string('destination', 32)   // E.164 number of the agent who picked up
  t.string('tag', 64)           // line tag from config (e.g. 'sofia', 'varna')
  t.string('status', 16).notNullable().defaultTo('ringing')  // ringing | active | ended | missed
  t.integer('duration')         // call duration in seconds, set on end
  t.string('record', 256)       // filename of the MP3 recording in recordsFolder
  t.string('link', 512)         // public URL to the MP3 recording
  t.text('transcription')       // full transcript produced by Whisper + GPT-4o normalization
  t.timestamp('started_at').notNullable()  // when the call first rang
  t.timestamp('picked_at')                 // when an agent answered, null if missed
  t.timestamp('ended_at')                  // when the call ended
  t.index('vault_id')
})

export const down = knex => knex.schema.dropTable('whitebox_voip_calls')
