// CRM no longer owns a store. Structured records now land in the core *facts*
// memory (ctx.facts), so the dedicated whitebox_crm_records table is retired.
// Drop it — the external systems still own the source data and re-ingest into
// facts. (Migration 001 is kept so the ledger stays consistent on deployments
// that already ran it; this drops what it created.)
export const up = knex => knex.schema.dropTableIfExists('whitebox_crm_records')

// Irreversible by design — the table's role is gone. Recreate from 001 if you
// ever truly need to roll back.
export const down = async () => {}
