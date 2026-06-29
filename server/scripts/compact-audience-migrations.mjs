// One-off: the audience `slug` migrations (011 add, 012 rename → activation_id) were
// folded into a canonical 010. With no users yet, drop their tracking rows so knex
// doesn't flag the (now deleted) files as missing. The live schema already matches 010.
//   run: cd server && node --env-file-if-exists=.env scripts/compact-audience-migrations.mjs
import { load as loadConfig } from '../src/config.js'
import * as db from '../src/db.js'

const config = await loadConfig({ argv: process.argv, env: process.env })
await db.init({ config })
const knex = db.get()
const removed = await knex('whitebox_audience_migrations')
  .where('name', 'like', '011\\_%').orWhere('name', 'like', '012\\_%').del()
console.log(`compacted: removed ${removed} stale audience-migration row(s)`)
await knex.destroy()
process.exit(0)
