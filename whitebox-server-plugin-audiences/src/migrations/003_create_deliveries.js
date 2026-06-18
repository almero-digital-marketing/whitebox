// Delivery = an append-only audit row for every event fired to a network.
// Powers /audiences/deliveries and the delivery_log MCP tool. See docs/09-api.md.

export const up = knex => knex.schema.createTable('whitebox_audience_deliveries', t => {
  t.bigIncrements('id')
  t.string('rule_id', 64).notNullable()
  t.uuid('passport_id').notNullable()
  t.string('network', 16).notNullable()         // 'meta' | 'tiktok' | 'google'
  t.string('event_name', 64).notNullable()
  t.string('event_id', 64).notNullable()        // idempotency / browser-pixel dedup key
  t.string('status', 16).notNullable()          // 'accepted' | 'rejected' | 'error'
  t.jsonb('matched_via')                         // which identity keys matched, e.g. ['fbp','email_hash']
  t.text('error')
  t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now())
  t.index(['rule_id', 'created_at'])
  t.index(['network', 'status'])
  t.index('passport_id')
})

export const down = knex => knex.schema.dropTable('whitebox_audience_deliveries')
