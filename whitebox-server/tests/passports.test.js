import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import knex from 'knex'
import dayjs from 'dayjs'

vi.mock('../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const { identify, link, identities, findByIdentity, resolve, merge, init } = await import('../src/passports.js')

// ---------------------------------------------------------------------------
// Lock mock — no Redis needed for passport tests
// ---------------------------------------------------------------------------

const lock = {
  acquire: vi.fn().mockResolvedValue({}),
  release: vi.fn().mockResolvedValue(null),
}

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

const db = knex({
  client: 'pg',
  connection: process.env.DATABASE_URL,
  pool: { min: 1, max: 5 },
})

beforeAll(async () => {
  await init({ db, lock, config: {} })
  // A synthetic table with a FK to passports — proves the catalog-driven merge
  // moves arbitrary referencing rows without the merge knowing the table exists.
  await db.schema.dropTableIfExists('wb_merge_test_refs')
  await db.schema.createTable('wb_merge_test_refs', t => {
    t.increments('id')
    t.uuid('passport_id').references('id').inTable('whitebox_passports')
    t.text('note')
  })
})

afterAll(async () => {
  await db.schema.dropTableIfExists('wb_merge_test_refs')
  await db.destroy()
})

beforeEach(async () => {
  // TRUNCATE … CASCADE clears passports + everything that references them
  // (identities, merges, and any sessions/exposures inherited from the parent
  // Neon branch), so the per-test slate is clean regardless of FK direction.
  await db.raw('TRUNCATE TABLE whitebox_passports CASCADE')
  lock.acquire.mockClear()
  lock.release.mockClear()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysAgo(n) {
  return dayjs().subtract(n, 'day').toDate()
}

// ---------------------------------------------------------------------------
// identify
// ---------------------------------------------------------------------------

describe('identify', () => {
  it('creates a new passport when no id is given', async () => {
    const id = await identify(null)
    expect(id).toBeTruthy()
    const row = await db('whitebox_passports').where({ id }).first()
    expect(row).toBeTruthy()
  })

  it('returns the same passport when a valid id is given', async () => {
    const first = await identify(null)
    const second = await identify(first)
    expect(second).toBe(first)
    const count = await db('whitebox_passports').count('id as n').first()
    expect(Number(count.n)).toBe(1)
  })

  it('creates a new passport when the id is not found in the database', async () => {
    const id = await identify('00000000-0000-0000-0000-000000000000')
    const count = await db('whitebox_passports').count('id as n').first()
    expect(Number(count.n)).toBe(1)
    expect(id).not.toBe('00000000-0000-0000-0000-000000000000')
  })

  it('updates last_seen_at on each call', async () => {
    const id = await identify(null)
    const { last_seen_at: before } = await db('whitebox_passports').where({ id }).first()
    await new Promise(r => setTimeout(r, 50))
    await identify(id)
    const { last_seen_at: after } = await db('whitebox_passports').where({ id }).first()
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime())
  })

  it('follows the merge chain and returns the survivor', async () => {
    const a = await identify(null)
    const b = await identify(null)
    await db('whitebox_passports_merges').insert({ absorbed_id: a, survivor_id: b })
    const resolved = await identify(a)
    expect(resolved).toBe(b)
  })

  it('follows a multi-hop merge chain', async () => {
    const a = await identify(null)
    const b = await identify(null)
    const c = await identify(null)
    await db('whitebox_passports_merges').insert({ absorbed_id: a, survivor_id: b })
    await db('whitebox_passports_merges').insert({ absorbed_id: b, survivor_id: c })
    const resolved = await identify(a)
    expect(resolved).toBe(c)
  })
})

// ---------------------------------------------------------------------------
// link — strong identities
// ---------------------------------------------------------------------------

describe('link — strong identities', () => {
  it('inserts a new strong identity', async () => {
    const id = await identify(null)
    await link(id, [{ type: 'phone', name: 'e164', value: '+35988000000' }])
    const row = await db('whitebox_passports_identities').where({ passport_id: id }).first()
    expect(row).toBeTruthy()
    expect(row.value).toBe('+35988000000')
  })

  it('updates last_seen_at when the same strong identity is linked again', async () => {
    const id = await identify(null)
    await link(id, [{ type: 'phone', name: 'e164', value: '+35988000000' }])
    const { last_seen_at: before } = await db('whitebox_passports_identities').where({ passport_id: id }).first()
    await new Promise(r => setTimeout(r, 50))
    await link(id, [{ type: 'phone', name: 'e164', value: '+35988000000' }])
    const { last_seen_at: after } = await db('whitebox_passports_identities').where({ passport_id: id }).first()
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime())
    const count = await db('whitebox_passports_identities').count('id as n').first()
    expect(Number(count.n)).toBe(1)
  })

  it('merges passports when a strong identity within lifespan is found on a different passport', async () => {
    const a = await identify(null)
    const b = await identify(null)
    await db('whitebox_passports_identities').insert({
      passport_id: a, type: 'phone', name: 'e164', value: '+35988000000',
      last_seen_at: daysAgo(1),
    })
    await link(b, [{ type: 'phone', name: 'e164', value: '+35988000000' }])
    const mergeRow = await db('whitebox_passports_merges').first()
    expect(mergeRow).toBeTruthy()
    // the triggering identity is MOVED onto the survivor (b), not lost
    const moved = await db('whitebox_passports_identities').where({ value: '+35988000000' }).first()
    expect(moved.passport_id).toBe(b)
    // the absorbed passport survives as a tombstone (not deleted)
    expect(await db('whitebox_passports').where({ id: a }).first()).toBeTruthy()
    expect(lock.acquire).toHaveBeenCalled()
    expect(lock.release).toHaveBeenCalled()
  })

  it('does not merge when the strong identity is outside its lifespan', async () => {
    const a = await identify(null)
    const b = await identify(null)
    await db('whitebox_passports_identities').insert({
      passport_id: a, type: 'phone', name: 'e164', value: '+35988000000',
      last_seen_at: daysAgo(31),
    })
    await link(b, [{ type: 'phone', name: 'e164', value: '+35988000000' }])
    const count = await db('whitebox_passports_merges').count('id as n').first()
    expect(Number(count.n)).toBe(0)
    expect(lock.acquire).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// link — weak identities
// ---------------------------------------------------------------------------

describe('link — weak identities', () => {
  it('inserts a new weak identity for the passport', async () => {
    const id = await identify(null)
    await link(id, [{ type: 'gender', name: 'gender', value: 'male' }])
    const row = await db('whitebox_passports_identities').where({ passport_id: id }).first()
    expect(row).toBeTruthy()
    expect(row.value).toBe('male')
  })

  it('updates last_seen_at for an existing weak identity on the same passport', async () => {
    const id = await identify(null)
    await link(id, [{ type: 'gender', name: 'gender', value: 'male' }])
    const { last_seen_at: before } = await db('whitebox_passports_identities').where({ passport_id: id }).first()
    await new Promise(r => setTimeout(r, 50))
    await link(id, [{ type: 'gender', name: 'gender', value: 'male' }])
    const { last_seen_at: after } = await db('whitebox_passports_identities').where({ passport_id: id }).first()
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime())
    const count = await db('whitebox_passports_identities').count('id as n').first()
    expect(Number(count.n)).toBe(1)
  })

  it('allows the same weak identity value on different passports without merging', async () => {
    const a = await identify(null)
    const b = await identify(null)
    await link(a, [{ type: 'gender', name: 'gender', value: 'male' }])
    await link(b, [{ type: 'gender', name: 'gender', value: 'male' }])
    const count = await db('whitebox_passports_identities').count('id as n').first()
    expect(Number(count.n)).toBe(2)
    const mergeCount = await db('whitebox_passports_merges').count('id as n').first()
    expect(Number(mergeCount.n)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// findByIdentity
// ---------------------------------------------------------------------------

describe('findByIdentity', () => {
  it('returns the passport when identity is found', async () => {
    const id = await identify(null)
    await link(id, [{ type: 'email', name: 'email', value: 'test@example.com' }])
    const passport = await findByIdentity('email', 'test@example.com')
    expect(passport).toBeTruthy()
    expect(passport.id).toBe(id)
  })

  it('returns null when identity is not found', async () => {
    const passport = await findByIdentity('email', 'unknown@example.com')
    expect(passport).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// identities
// ---------------------------------------------------------------------------

describe('identities', () => {
  it('returns all identities for the passport', async () => {
    const id = await identify(null)
    await link(id, [
      { type: 'phone', name: 'e164', value: '+35988000000' },
      { type: 'gender', name: 'gender', value: 'male' },
    ])
    const result = await identities(id)
    expect(result).toHaveLength(2)
  })

  it('resolves through the merge chain before returning identities', async () => {
    const a = await identify(null)
    const b = await identify(null)
    await link(b, [{ type: 'gender', name: 'gender', value: 'male' }])
    await db('whitebox_passports_merges').insert({ absorbed_id: a, survivor_id: b })
    const result = await identities(a)
    expect(result).toHaveLength(1)
    expect(result[0].passport_id).toBe(b)
  })
})

// ---------------------------------------------------------------------------
// merge — non-destructive, catalog-driven
// ---------------------------------------------------------------------------

describe('merge', () => {
  it('moves identities + all FK references to the survivor and keeps the absorbed as a tombstone', async () => {
    const survivor = await identify(null)
    const absorbed = await identify(null)
    await link(absorbed, [
      { type: 'email', name: 'email', value: 'x@y.com' },   // strong
      { type: 'gender', name: 'gender', value: 'male' },     // weak
    ])
    await db('wb_merge_test_refs').insert([{ passport_id: absorbed, note: 'a' }, { passport_id: absorbed, note: 'b' }])

    const result = await merge(survivor, absorbed)
    expect(result).toBe(survivor)

    // identities moved off the absorbed onto the survivor
    const ids = await db('whitebox_passports_identities').where({ passport_id: survivor })
    expect(ids.map(i => i.value).sort()).toEqual(['male', 'x@y.com'])
    expect(await db('whitebox_passports_identities').where({ passport_id: absorbed }).first()).toBeUndefined()

    // arbitrary FK rows moved — discovered from the catalog, not hardcoded
    const refs = await db('wb_merge_test_refs').where({ passport_id: survivor })
    expect(refs).toHaveLength(2)
    expect(await db('wb_merge_test_refs').where({ passport_id: absorbed }).first()).toBeUndefined()

    // absorbed passport is NOT deleted; resolve() forwards it to the survivor
    expect(await db('whitebox_passports').where({ id: absorbed }).first()).toBeTruthy()
    expect(await resolve(absorbed)).toBe(survivor)
  })

  it('dedupes a weak identity already present on the survivor', async () => {
    const survivor = await identify(null)
    const absorbed = await identify(null)
    await link(survivor, [{ type: 'gender', name: 'gender', value: 'male' }])
    await link(absorbed, [{ type: 'gender', name: 'gender', value: 'male' }])
    await merge(survivor, absorbed)
    const genders = await db('whitebox_passports_identities').where({ type: 'gender', value: 'male' })
    expect(genders).toHaveLength(1)
    expect(genders[0].passport_id).toBe(survivor)
  })

  it('is a no-op when survivor === absorbed', async () => {
    const p = await identify(null)
    expect(await merge(p, p)).toBe(p)
    const { n } = await db('whitebox_passports_merges').count('id as n').first()
    expect(Number(n)).toBe(0)
  })

  it('compacts the merge chain (re-points an existing survivor_id)', async () => {
    const a = await identify(null)
    const b = await identify(null)
    const c = await identify(null)
    await merge(b, a)   // a → b
    await merge(c, b)   // b → c  (should also re-point a → c)
    expect(await resolve(a)).toBe(c)
  })
})
