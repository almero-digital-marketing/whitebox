import { randomUUID } from 'crypto'
import dayjs from 'dayjs'
import logger from './logger.js'

const PASSPORTS = 'whitebox_passports'
const IDENTITIES = 'whitebox_passports_identities'
const MERGES = 'whitebox_passports_merges'

// Identity types used as merge keys — if two passports share one, they are the same person
const STRONG = new Set(['fingerprint', 'phone', 'email', 'user'])

const DEFAULT_LIFESPANS = {
  fingerprint: 7,
  phone: 30,
  email: 365,
  user: Infinity,
}

let db
let lock
let lifespans

export async function init(options) {
  db = options.db
  lock = options.lock
  lifespans = { ...DEFAULT_LIFESPANS, ...options.config?.passports?.lifespans }

  const passportsExists = await db.schema.hasTable(PASSPORTS)
  if (!passportsExists) {
    await db.schema.createTable(PASSPORTS, t => {
      t.uuid('id').primary()
      t.timestamp('created_at').notNullable().defaultTo(db.fn.now())
      t.timestamp('last_seen_at')
    })
    logger.info('Passports table created')
  }

  const identitiesExists = await db.schema.hasTable(IDENTITIES)
  if (!identitiesExists) {
    await db.schema.createTable(IDENTITIES, t => {
      t.increments('id')
      t.uuid('passport_id').notNullable().references('id').inTable(PASSPORTS).onDelete('CASCADE')
      t.string('type', 32).notNullable()
      t.string('name', 64).notNullable()
      t.string('value', 512).notNullable()
      t.timestamp('created_at').notNullable().defaultTo(db.fn.now())
      t.timestamp('last_seen_at').notNullable().defaultTo(db.fn.now())
      t.unique(['passport_id', 'type', 'name', 'value'])
      t.index('passport_id')
    })
    // Strong identity types must be globally unique — one passport per phone/email/fingerprint
    await db.raw(`
      CREATE UNIQUE INDEX ${IDENTITIES}_strong_unique ON ${IDENTITIES} (type, value)
      WHERE type IN ('fingerprint', 'phone', 'email', 'user')
    `)
    logger.info('Passports identities table created')
  }

  const mergesExists = await db.schema.hasTable(MERGES)
  if (!mergesExists) {
    await db.schema.createTable(MERGES, t => {
      t.increments('id')
      t.uuid('absorbed_id').notNullable()
      t.uuid('survivor_id').notNullable().references('id').inTable(PASSPORTS)
      t.timestamp('merged_at').notNullable().defaultTo(db.fn.now())
      t.index('absorbed_id')
    })
    logger.info('Passports merges table created')
  }
}

export async function resolve(passportId) {
  while (passportId) {
    const merge = await db(MERGES).where({ absorbed_id: passportId }).orderBy('merged_at', 'desc').first()
    if (!merge) break
    passportId = merge.survivor_id
  }
  return passportId
}

function isWithinLifespan(type, lastSeenAt) {
  const days = lifespans[type]
  if (!days) return false
  const within = dayjs().diff(dayjs(lastSeenAt), 'day') <= days
  return within
}

export async function identify(passportId) {
  passportId = await resolve(passportId)

  if (passportId) {
    const row = await db(PASSPORTS).where({ id: passportId }).first()
    if (!row) passportId = null
  }

  if (!passportId) {
    passportId = randomUUID()
    await db(PASSPORTS).insert({ id: passportId })
  }

  await db(PASSPORTS).where({ id: passportId }).update({ last_seen_at: dayjs().toDate() })

  return passportId
}

export async function identities(passportId) {
  passportId = await resolve(passportId)
  const rows = await db(IDENTITIES).where({ passport_id: passportId })
  return rows
}

export async function findByIdentity(type, value) {
  const row = await db(IDENTITIES).where({ type, value }).first()
  if (!row) return null
  const passport = await db(PASSPORTS).where({ id: row.passport_id }).first()
  return passport
}

export async function link(passportId, items) {
  passportId = await resolve(passportId)
  const now = dayjs().toDate()

  for (const item of items) {
    if (STRONG.has(item.type)) {
      // Strong identities are globally unique — find across all passports
      const existing = await db(IDENTITIES).where({ type: item.type, value: item.value }).first()

      if (!existing) {
        await db(IDENTITIES).insert({ passport_id: passportId, type: item.type, name: item.name, value: item.value, last_seen_at: now }).catch(err => {
          if (!err.message?.includes('unique') && !err.message?.includes('duplicate')) throw err
        })
        continue
      }

      await db(IDENTITIES).where({ id: existing.id }).update({ last_seen_at: now })

      if (existing.passport_id !== passportId && isWithinLifespan(item.type, existing.last_seen_at)) {
        await merge(passportId, existing.passport_id)
      }
    } else {
      // Weak identities are per passport — update last_seen_at if exists, insert if not
      const existing = await db(IDENTITIES).where({ passport_id: passportId, type: item.type, name: item.name, value: item.value }).first()

      if (existing) {
        await db(IDENTITIES).where({ id: existing.id }).update({ last_seen_at: now })
      } else {
        await db(IDENTITIES).insert({ passport_id: passportId, type: item.type, name: item.name, value: item.value, last_seen_at: now })
      }
    }
  }
}

// Merge `absorbed` into `survivor`: move every reference onto the survivor and
// record the merge so resolve() forwards future hits. NON-DESTRUCTIVE — the
// absorbed passport is kept as a childless tombstone (no CASCADE data loss, no
// FK-violation on a delete). References are discovered from the Postgres catalog,
// so any table with a FK to whitebox_passports is moved automatically — no
// hardcoded table list, new plugin tables included for free.
export async function merge(survivorId, absorbedId) {
  survivorId = await resolve(survivorId)
  absorbedId = await resolve(absorbedId)
  if (!survivorId || !absorbedId || survivorId === absorbedId) return survivorId

  const key = [survivorId, absorbedId].sort().join(':')
  const acquired = await lock.acquire(`passport:merge:${key}`, 5000)

  try {
    await db.transaction(async trx => {
      // 1. Identities. Strong types are globally unique on (type, value), so the
      //    survivor can never already hold the same value → always safe to move.
      //    Weak types are per-passport → dedupe against the survivor.
      const absorbed = await trx(IDENTITIES).where({ passport_id: absorbedId })
      for (const id of absorbed) {
        if (STRONG.has(id.type)) {
          await trx(IDENTITIES).where({ id: id.id }).update({ passport_id: survivorId })
        } else {
          const dup = await trx(IDENTITIES)
            .where({ passport_id: survivorId, type: id.type, name: id.name, value: id.value }).first()
          if (dup) await trx(IDENTITIES).where({ id: id.id }).del()
          else await trx(IDENTITIES).where({ id: id.id }).update({ passport_id: survivorId })
        }
      }

      // 2. Every OTHER table with a single-column FK to whitebox_passports(id),
      //    discovered from the catalog. passport_id is never part of a unique
      //    constraint outside identities (handled above), so a blind re-point is
      //    safe. (This also compacts whitebox_passports_merges.survivor_id.)
      const { rows } = await trx.raw(`
        SELECT cl.relname AS tbl, a.attname AS col
        FROM pg_constraint con
        JOIN pg_class cl     ON cl.oid = con.conrelid
        JOIN pg_attribute a  ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
        WHERE con.contype = 'f'
          AND con.confrelid = 'whitebox_passports'::regclass
          AND array_length(con.conkey, 1) = 1
      `)
      for (const { tbl, col } of rows) {
        if (tbl === IDENTITIES) continue
        await trx(tbl).where(col, absorbedId).update({ [col]: survivorId })
      }

      // 3. Record the alias so resolve() forwards absorbed → survivor. The
      //    absorbed passport row stays (now childless) — we do NOT delete it.
      await trx(MERGES).insert({ absorbed_id: absorbedId, survivor_id: survivorId })
    })
    logger.info('Merged passport %s into %s', absorbedId, survivorId)
  } finally {
    await lock.release(acquired)
  }

  return survivorId
}
