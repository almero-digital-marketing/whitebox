// Conversion events — an audit log of every conversion received from the
// browser and what happened when we fanned it out to the ad networks. The
// event_id is unique: the browser may double-fire (sendBeacon on unload), and
// it's the same key the network pixels dedupe on, so it's our idempotency key.

export const up = knex => knex.schema.createTable('whitebox_conversion_events', t => {
  t.increments('id')
  // Nullable + SET NULL so a GDPR forget (passport delete) keeps the audit row
  // but detaches the person.
  t.uuid('passport_id').nullable().references('id').inTable('whitebox_passports').onDelete('SET NULL')
  t.string('event_id', 128).notNullable().unique()   // idempotency + pixel dedup key
  t.string('name', 64).notNullable()                 // canonical standard name or custom event name
  t.string('kind', 16).notNullable()                 // 'standard' | 'custom'
  t.decimal('value', 14, 2).nullable()
  t.string('currency', 8).nullable()
  t.string('url', 1024).nullable()
  t.jsonb('networks').notNullable().defaultTo('{}')  // { meta: 'accepted', google: 'skipped', … }
  t.jsonb('payload').notNullable().defaultTo('{}')   // the validated event payload (audit)
  t.timestamp('received_at').notNullable().defaultTo(knex.fn.now())
  t.index('passport_id')
  t.index('name')
  t.index('received_at')
})

export const down = knex => knex.schema.dropTable('whitebox_conversion_events')
