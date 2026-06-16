// CRM records — owned by an external system (Booking, HubSpot, Stripe, etc.)
// and linked to a whitebox passport. Identity in this table is the external
// system's identity: (source, kind, external_id). Upsert on that tuple.
//
// We do NOT create a record without a known passport — records with no
// resolvable customer are dropped at ingest time.
export const up = knex => knex.schema.createTable('whitebox_crm_records', t => {
  t.increments('id')
  // Nullable so GDPR forget (passport delete) doesn't cascade-destroy the CRM
  // record — the external system still owns it. Ingest will reject records
  // that arrive without a resolvable passport in the first place.
  t.uuid('passport_id').nullable().references('id').inTable('whitebox_passports').onDelete('SET NULL')
  t.string('source', 64).notNullable()        // e.g. 'booking', 'hubspot', 'stripe'
  t.string('kind', 64).notNullable()          // e.g. 'reservation', 'deal', 'subscription'
  t.string('external_id', 256).notNullable()  // CRM-side row id
  t.string('status', 64).nullable()           // free-form, CRM-side status
  t.timestamp('starts_at').nullable()         // when the record's "event" happens (check-in, due date, etc.)
  t.jsonb('data').notNullable().defaultTo('{}')
  t.timestamp('created_at').notNullable().defaultTo(knex.fn.now())
  t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now())
  t.unique(['source', 'kind', 'external_id'])
  t.index('passport_id')
  t.index(['source', 'kind'])
  t.index('starts_at')
})

export const down = knex => knex.schema.dropTable('whitebox_crm_records')
