// Audiences — a deliverable audience is a boolean COMPOSITION of segments (AND / OR /
// NOT). It stores only the rule + delivery config, never a frozen list of people: it is
// re-resolved fresh at apply-time, like a segment. `activation_id` is the stable id this
// audience is known by — sent to the ad networks (CAPI, as the custom-audience key) and
// read by the client side for membership. rule: { op:'all'|'any', members:[{segment, negate?}] }
// See docs/11-segments-and-audiences.md.

export const up = knex => knex.schema.createTable('whitebox_audiences', t => {
  t.uuid('id').primary()
  t.text('name').notNullable()
  t.text('activation_id').unique()                        // stable human id (CAPI key + client membership)
  t.jsonb('rule').notNullable()                           // boolean composition of segment ids
  t.jsonb('delivery')                                     // per-network delivery config
  t.boolean('client_side').notNullable().defaultTo(false) // exposed to the client side (on-site membership lookup)?
  t.boolean('campaigns').notNullable().defaultTo(false)   // available to the Campaigns module (email & SMS)?
  t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now())
  t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now())
  t.index('created_at')
})

export const down = knex => knex.schema.dropTable('whitebox_audiences')
