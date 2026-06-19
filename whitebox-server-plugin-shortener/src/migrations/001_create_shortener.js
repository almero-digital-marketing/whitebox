// Short links + their click/claim audit.
//
// A link's `code` is the opaque public handle; the passport it binds to lives
// here, never in the URL. `passport_id` is a real FK so the core passport merge
// re-points it automatically (a link bound to a passport that later gets
// absorbed follows to the survivor). Clicks hold the single-use claim token.

export const up = async knex => {
  await knex.schema.createTable('whitebox_short_links', t => {
    t.increments('id')
    t.string('code', 32).notNullable().unique()
    // Bound customer. SET NULL on delete (passports aren't deleted in normal
    // operation — merge keeps a tombstone — but stay safe for GDPR forget).
    t.uuid('passport_id').nullable().references('id').inTable('whitebox_passports').onDelete('SET NULL')
    t.text('url').notNullable()                       // destination
    t.jsonb('data').notNullable().defaultTo('{}')     // prefill + tags (name, utm, …)
    t.jsonb('identify').nullable()                    // {email|phone|external_id} resolved at click time
    t.string('label', 128).nullable()
    t.integer('click_count').notNullable().defaultTo(0)
    t.integer('max_clicks').nullable()
    t.timestamp('expires_at').nullable()              // redirect lifetime
    t.timestamp('identity_expires_at').nullable()     // absolute bind cutoff
    t.timestamp('identity_consumed_at').nullable()    // set on first successful claim (single-use identity)
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now())
  })

  await knex.schema.createTable('whitebox_short_clicks', t => {
    t.increments('id')
    t.string('code', 32).notNullable()
    t.string('claim_token', 64).notNullable().unique() // single-use ticket handed to the browser
    t.uuid('passport_id').nullable()                   // who claimed it (audit; denormalized, no FK)
    t.timestamp('expires_at').notNullable()            // short TTL — claim must land promptly
    t.timestamp('claimed_at').nullable()               // single-use marker
    t.string('ip', 64).nullable()
    t.string('user_agent', 512).nullable()
    t.timestamp('ts').notNullable().defaultTo(knex.fn.now())
    t.index('code')
  })
}

export const down = async knex => {
  await knex.schema.dropTableIfExists('whitebox_short_clicks')
  await knex.schema.dropTableIfExists('whitebox_short_links')
}
