// One-off: add the audience activation-channel flag columns (client_side, campaigns) to the
// existing dev DB. Canonical 010 now declares them; this reconciles the already-migrated dev
// table. Idempotent — safe to re-run.
//   run: cd server && node --env-file-if-exists=.env scripts/add-audience-channel-columns.mjs
import { load as loadConfig } from '../src/config.js'
import * as db from '../src/db.js'
const config = await loadConfig({ argv: process.argv, env: process.env })
await db.init({ config })
const knex = db.get()
for (const col of ['client_side', 'campaigns']) {
  if (await knex.schema.hasColumn('whitebox_audiences', col)) { console.log(`whitebox_audiences.${col} already present`); continue }
  await knex.schema.alterTable('whitebox_audiences', t => t.boolean(col).notNullable().defaultTo(false))
  console.log(`added whitebox_audiences.${col}`)
}
await knex.destroy(); process.exit(0)
