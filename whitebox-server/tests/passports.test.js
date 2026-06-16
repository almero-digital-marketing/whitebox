import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import knex from 'knex'
import dayjs from 'dayjs'

vi.mock('../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const { identify, link, identities, findByIdentity, init } = await import('../src/passports.js')

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

const TABLES = [
  'whitebox_passports_merges',
  'whitebox_passports_identities',
  'whitebox_passports',
]

beforeAll(async () => {
  await init({ db, lock, config: {} })
})

afterAll(async () => {
  await db.destroy()
})

beforeEach(async () => {
  for (const table of TABLES) {
    await db(table).del()
  }
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
    const merge = await db('whitebox_passports_merges').first()
    expect(merge).toBeTruthy()
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
