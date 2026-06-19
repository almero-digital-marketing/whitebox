// Browser-collected ad identifiers per passport (the client capture shim posts
// these). Hashed PII (email/phone) is NOT stored here — it's resolved at send
// time from the passport's identities. See docs/06-identity.md.

export const up = knex => knex.schema.createTable('whitebox_audience_identities', t => {
  t.uuid('passport_id').primary()
  // { fbp, fbc, fbclid, ttclid, ttp, ga_client_id, gclid, gbraid, wbraid, user_agent, ... }
  t.jsonb('signals').notNullable().defaultTo('{}')
  t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now())
})

export const down = knex => knex.schema.dropTable('whitebox_audience_identities')
